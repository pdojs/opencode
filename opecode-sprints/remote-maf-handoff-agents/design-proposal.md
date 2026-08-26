# Remote MAF Handoff Agents in OpenCode — Design Proposal

## Preliminary investigation and root cause

Grounded via direct exploration of `/Users/pdops/projects/opencode` and `/Users/pdops/projects/agent-framework/python/packages/orchestrations/agent_framework_orchestrations/_handoff.py`.

**Root cause**: OpenCode's extension points for "where does a Session actually run" (`Location`) and "how do tool calls execute" (`Tool.Def` + `registry.ts`) are both hard-wired to local-only implementations, and there is no protocol for an external process to (a) publish assistant turn deltas into OpenCode's existing `EventV2`/SSE pipeline or (b) request a tool execution and receive a result back. The custom repo instructions explicitly reserve `Location.workspaceID` for "future placement semantics" (`packages/core/src/session/execution.ts:20` comment: "Routes execution from a Session ID to the runner owned by that Session's Location") — this is the intended seam to extend, not a workaround.

**Supporting evidence** (file:line):
- `packages/core/src/session/execution.ts:9-20` — `SessionExecution.Service` interface (`active`, `resume`, `wake`, `interrupt`) is already Session-ID + Location based, not tied to a concrete local runner type.
- `packages/opencode/src/agent/agent.ts:34-52` — `Agent.Info` schema has no `origin`/`endpoint` field; adding one would conflate "local subagent definition" with "alternate execution backend," which are different concepts (a remote MAF orchestrator is not a promptable subagent template, it's a whole external session runner).
- `packages/opencode/src/provider/provider.ts` (`baseURL`/`options.endpoint` override pattern, e.g. lines ~251, 355-358, 730-732) — existing precedent for describing an external HTTP-addressable backend by `providerID` + `baseURL`; the closest analog for how a "remote agent server" should be configured/addressed.
- `packages/opencode/src/mcp/*` + `McpCatalog` — the only existing precedent in the codebase for a tool whose execution crosses a process/network boundary (MCP server process). This is the template for the new "remote tool bridge," not a from-scratch design.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` — SSE stream keyed off `EventV2.Interface.listen`, filtered by `location.directory`/`workspaceID`; new remote-agent events must be published onto this same bus to reuse TUI rendering unmodified.
- `packages/opencode/src/server/routes/instance/websocket-tracker.ts` + `groups/pty.ts`/`handlers/pty.ts` — existing WebSocket usage is scoped to interactive PTY only; a new WS surface is needed for the remote-agent tool-bridge channel (bidirectional), following the same tracker pattern.
- `packages/tui/src/keymap.tsx:31-36,272-277` + `packages/tui/src/app.tsx:580-762` — command registration is just objects with `slashName`/`slashAliases` pushed into a keymap layer; adding `/agent` is additive, no registry rewrite needed.
- MAF side: `_handoff.py` implements the workflow itself (`HandoffConfiguration`, `HandoffSentEvent`) but has **no server wrapper** — it is a Python library object (`Workflow`), not a network service. A FastAPI/WS wrapper must be authored from scratch in the container image; this is new code, not an existing gap in MAF to fix.
- `agent-framework/python/samples/05-end-to-end/ag_ui_workflow_handoff/backend/server.py` — a real, working precedent for wrapping a handoff-style workflow in FastAPI/uvicorn (`add_agent_framework_fastapi_endpoint` from `agent_framework.ag_ui`, `HandoffBuilder`), though it speaks the AG-UI wire protocol, not the one this feature defines. Useful as a "run/iterate locally without Docker" reference (`uvicorn server:app --reload`, curl/websocket-client against `localhost`), not as code to reuse directly (different wire protocol, per Decision #1).

## Testing Strategy

Four layers, from fastest/most-deterministic to slowest/most-realistic. Layers 1-3 are fully automated (`bun test` / `pytest`), run in CI, and require no Docker or real LLM calls — they exercise the exact wire-protocol and tool-execution code paths so protocol bugs are caught long before the manual layer 4 pass. Layer 4 is the only layer that needs Docker, a real LLM, and a human, and mainly validates end-to-end operator UX and real-handoff behavior rather than protocol correctness.

**Layer 1 — WS1 container contract tests (Python, no Docker, no real LLM)**
- Grounded in `agent-framework/python/packages/orchestrations/tests/test_handoff.py`, which already tests `_handoff.py`'s handoff routing deterministically using `AsyncMock`/`MagicMock` fake chat clients (`test_handoff.py:6-40`) — no live model calls. WS1's server tests reuse this exact fixture style: build a two-fake-agent handoff workflow whose second agent is scripted to always claim the handoff tool, so the transcript and handoff sequence are deterministic and assertable.
- New `tests/test_server.py` (colocated with WS1's `server.py`) drives the FastAPI app directly via `httpx.ASGITransport`/`TestClient` (HTTP) and the `websockets` test client (WS) against the in-process ASGI app — no `uvicorn`/Docker process needed. Asserts: `GET /agents/manifest` shape; a `user_message` frame against the deterministic fixture yields `assistant_delta`* → `handoff{source,target}` → `assistant_delta`* → `turn_complete` in order; a scripted tool-using fake agent produces a `tool_call` frame, and a `tool_result` frame sent back on the same socket unblocks the workflow and is reflected in the final transcript; an unrecognized `type` frame is rejected with an error frame, not a crash.
- Run via `pytest` (or `uv run pytest`) from the sample directory, following existing `agent-framework` test conventions.

**Layer 2 — WS2/WS3 automated integration tests (TypeScript, no Docker, no Python, no real network)**
- New `packages/core/test/lib/remote-agent-server.ts`, a fake in-process WS server speaking the exact wire protocol from `remote-protocol.ts`/`protocol.py`, modeled directly on two existing precedents: `packages/opencode/test/lib/llm-server.ts` (scriptable queued-response fake server pattern) and `packages/opencode/test/plugin/openai-ws.test.ts` (spinning up a real `ws`-library `WebSocketServer` in-process and connecting a real client against it, e.g. `createWebSocketServer` helper at that file's bottom). It supports scripting a sequence of `assistant_delta`/`handoff`/`turn_complete`/`tool_call` frames and recording the `user_message`/`tool_result` frames the client sends back.
- New `packages/core/test/session-runner-remote.test.ts` (naming matches existing siblings `session-runner-tool-events.test.ts`, `session-runner-model.test.ts` in the same directory). Reuses the `EventV2` capture-double pattern from `session-runner-tool-events.test.ts:14-33` (`EventV2.Service.of({ publish: ... captures into an array ... })`) to assert: `RemoteLocationRunner` opens the fake WS on `run()`, forwards each `assistant_delta` into the same `EventV2` shape `publish-llm-event.ts` produces (so the TUI needs no rendering change), publishes a `session.remote-handoff` event per `handoff` frame with `{source, target}`, and closes/cancels the socket when `SessionExecution.Service.interrupt` fires.
- New `packages/core/test/remote-tool-bridge.test.ts` scripts the fake server to emit a `tool_call` for a mapped name (e.g. `"bash"`), and asserts: the real local `Tool.Def` (`ShellTool`) executes against a real temporary workspace directory (following the existing temp-dir fixture pattern used by other `packages/core/test/*` tool tests), the permission path is exercised via the same `Context.ask`/`Ruleset` evaluation already covered by `packages/core/test/policy.test.ts`'s `AppNodeBuilder.build`/`testEffect` harness (reused, not reinvented), the resulting `tool_result` frame is sent back on the fake socket with real command output, and an unmapped tool name yields an error `tool_result` frame rather than a crash or silent drop.
- Run via `bun test` (existing `packages/core` test script), fully deterministic and CI-safe.

**Layer 3 — WS4 picker-logic tests (TypeScript, no terminal rendering needed)**
- The Native/Workspace/Remote `category` assignment (design change in WS4 step 2-3) is extracted as a small pure function so it is unit-testable without rendering the dialog, following the existing `packages/tui/test/context/local.test.ts` precedent (that file already unit-tests agent-list-adjacent logic from `context/local` in isolation). New/extended test asserts: native agents get `category: "Native"`, config/`.md`-defined agents get `category: "Workspace"`, manifest-derived entries get `category: "Remote"`, and section order is Native → Workspace → Remote regardless of input order (matches `DialogSelect`'s first-seen-order `groupBy`, `dialog-select.tsx:186-196`).
- Run via `bun test` (existing `packages/tui` test script).

**Layer 4 — WS5 real end-to-end (manual, Docker + real LLM required)**
- `docker compose up` (WS5's `docker-compose.yml`) starts the real WS1 container image (built from its `Dockerfile`, not a fake) plus a Phoenix instance.
- `VERIFY.md` is a concrete, repeatable script — not a vague checklist — with an expected observable result after each step:
  1. Configure `remoteAgent.servers` in OpenCode pointing at the compose container's published port.
  2. Start OpenCode per the repo dev convention: `tmux new-session -d -s opencode-dev 'bun dev'` from `packages/opencode`, then `tmux capture-pane -pt opencode-dev` to inspect output without blocking.
  3. Run `/agent`; expect three headed sections (Native, Workspace, Remote) with the container's declared orchestrator visible under Remote.
  4. Select the remote orchestrator; send a message designed to trigger a real handoff between two sample agents; expect incremental streamed text plus a visible handoff indicator naming the newly active agent.
  5. Send a follow-up message while the turn is still streaming; expect it to steer/queue exactly as today's local sessions do (no separate "remote busy" UI state).
  6. Prompt the active remote agent to run a real shell command or file edit; expect the existing local permission prompt to appear; approve it; then independently verify via a plain local `ls`/`cat` (outside OpenCode) that the real file/command effect exists in the actual workspace directory, not just echoed in the container.
  7. Interrupt the session from the TUI; expect the WS connection to close or the container to log a cancellation.
  8. Open the Phoenix UI (separate docker-compose service) and confirm an OTel trace exists for the same run, independent of the OpenCode interactive path.
  9. `tmux kill-session -t opencode-dev` to clean up.

---


### WS1 — maf-container-server

**Goal**: A Docker container running a MAF handoff-pattern workflow exposes an HTTP+WebSocket API that OpenCode can query for its manifest, stream a chat turn from, and receive/answer tool-call requests over.

**Problem**: MAF's `Workflow`/`_handoff.py` is a Python library object with no network surface; nothing today lets an external client discover, converse with, or receive tool-call requests from a running handoff workflow.

**Investigation/root cause**: Confirmed via `_handoff.py:1-100` — the module defines `HandoffConfiguration`, `HandoffSentEvent`, and workflow-building logic (`OrchestrationWorkflowBuilder`), all consumed in-process via `agent_framework._workflows._workflow.Workflow`. No FastAPI/ASGI wrapper exists in `agent-framework` for this or any orchestration pattern (confirmed no `server`/`fastapi` hits under `packages/orchestrations`). This is new code to author, not a bug to fix.

**Definition of Done**:
- `GET /agents/manifest` returns JSON listing at least one orchestrator with `{id, name, description, participants: [{id, name}]}`.
- `WS /agents/{id}/session` accepts a JSON `{type: "user_message", text}` frame and streams back `{type: "assistant_delta", text}` frames followed by a `{type: "turn_complete"}` frame, with `{type: "handoff", source, target}` frames emitted whenever `HandoffSentEvent` fires.
- The same WS channel accepts a `{type: "tool_result", call_id, output}` frame from the client and, when the active agent's tool schema includes a `bash`/`edit`-style tool, emits `{type: "tool_call", call_id, name, arguments}` requesting the client execute it (the container does **not** execute these itself).
- The WS channel additionally accepts a `{type: "steer_to_agent", agent_id}` frame (used by WS4's participant-targeting UI, see Decision #7). **Constraint, confirmed by investigation**: `_handoff.py`'s routing is entirely LLM-tool-call-decided (`_create_handoff_tool`/`_is_handoff_requested`, `_handoff.py:124-127,335-346,487-`) — there is no `HandoffBuilder`/`Workflow` API to force-switch the active agent. `steer_to_agent` is therefore implemented as advisory: the server injects a synthetic, clearly-marked user-visible instruction ("The user has requested you hand off to `<agent_id>` now.") as the next turn's message to whichever agent currently holds the conversation, relying on that agent's already-wired `handoff_to_<target_id>` tool to comply. It is not a hard override, and sample agents' prompts must be written to reliably comply with explicit user handoff requests for the demo to be deterministic.
- OTel exporter configured via `openinference-instrumentation-agent-framework`, pointed at a Phoenix collector endpoint from container env var, independently verified in the Phoenix UI.
- `docker build` produces an image; running it standalone (`curl localhost:PORT/agents/manifest`) succeeds without OpenCode running.

**Resolution via WBS**:
1. Author `server.py` (FastAPI app) in a new `agent-framework`-adjacent sample/service directory (exact location TBD at implementation time — likely a new top-level `python/samples/05-end-to-end/opencode-handoff-bridge/` sibling to the existing `ag_ui_workflow_handoff` sample, mirroring its structure), plus `tests/test_server.py` covering the `GET /agents/manifest` shape against a deterministic fake-agent fixture (see Testing Strategy Layer 1) in the same commit. Commit: `Container: add FastAPI manifest + WS chat server`.
2. Wire `_handoff.py`'s workflow build function into the server's session lifecycle: one workflow instance per WS connection, replaying `HandoffSentEvent` and per-agent response streaming into the wire frames defined above; extend `tests/test_server.py` with the deterministic two-fake-agent handoff sequence assertion (`assistant_delta`* → `handoff` → `assistant_delta`* → `turn_complete`) in the same commit. Commit: `Container: bridge handoff workflow events to WS frames`.
3. Implement the tool-call request/response half of the protocol: intercept the active agent's tool invocations before local execution, emit `tool_call`, block on `tool_result` from the client with a timeout, and feed the result back into the agent's tool-call response; extend `tests/test_server.py` with the tool-call/tool-result round-trip and the unrecognized-frame-type rejection case in the same commit. Commit: `Container: add tool-call bridge over WS`.
4. Implement `steer_to_agent`: on receipt, construct the synthetic instruction message and inject it as the active agent's next input via the same code path `user_message` uses; extend `tests/test_server.py` with a deterministic three-fake-agent fixture asserting the targeted agent becomes active after a `steer_to_agent` frame. Commit: `Container: add steer_to_agent participant targeting`.
5. Add `openinference-instrumentation-agent-framework` + OTel exporter config (env-var driven collector endpoint). Commit: `Container: wire OTel export to Phoenix`.
6. Write `Dockerfile` for the server. Commit: `Container: add Dockerfile for handoff bridge server`.

**Specific change surface** — **as implemented** (superseding the original plan below, which
assumed a location inside the `agent-framework` checkout): `test/remote-maf-handoff-agents/`
inside the `opencode` repo (see `wbs.md`'s Implementation status note for why), as its own
standalone Python app depending on published `agent-framework-*` PyPI packages rather than a
local path dependency:
- `test/remote-maf-handoff-agents/app/server.py` — FastAPI app, manifest + WS session, tool bridge, steer_to_agent handling.
- `test/remote-maf-handoff-agents/app/protocol.py` — wire frame Pydantic models, shared contract WS2 will mirror in TypeScript.
- `test/remote-maf-handoff-agents/app/orchestrator.py` — sample triage/billing/refunds HandoffBuilder workflow + manifest metadata.
- `test/remote-maf-handoff-agents/app/telemetry.py` — OTel export to Phoenix, env-var gated.
- `test/remote-maf-handoff-agents/app/main.py` — uvicorn ASGI entrypoint.
- `test/remote-maf-handoff-agents/tests/test_server.py` — Layer 1 contract tests, deterministic fake-agent fixtures modeled on `packages/orchestrations/tests/test_handoff.py`'s `MockChatClient`/`MockHandoffAgent` pattern (5/5 passing).
- `test/remote-maf-handoff-agents/Dockerfile`, `README.md`, `pyproject.toml`, `.gitignore` (new).

Original plan (kept for reference; not the actual location used):
- ~~`agent-framework/python/samples/05-end-to-end/opencode-handoff-bridge/server.py`~~
- ~~`agent-framework/python/samples/05-end-to-end/opencode-handoff-bridge/protocol.py`~~
- ~~`agent-framework/python/samples/05-end-to-end/opencode-handoff-bridge/tests/test_server.py`~~
- ~~`agent-framework/python/samples/05-end-to-end/opencode-handoff-bridge/Dockerfile`~~

---

### WS2 — remote-location-runner

**Goal**: OpenCode can bind a Session's execution to a configured remote MAF container instead of the local LLM runner, using the existing `Location`-based execution routing seam.

**Problem**: `SessionExecution`'s Location routing only resolves to `LocationServiceMap`'s local implementation; no `RemoteLocationRunner` exists, and there's no config schema describing "these are my remote agent containers."

**Investigation/root cause**: `packages/core/src/session/execution.ts:20` comment and the custom repo instruction "`LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID... explicit workspace identity remains reserved for future placement semantics" together confirm `Location` is the designed seam for exactly this extension — not a workaround.

**Definition of Done**:
- A new config surface (project or global config, following the `ConfigAgent`-style self-export pattern in `src/config`) lets the user list remote agent servers by URL, e.g. `remoteAgent.servers: [{id, url}]`.
- Selecting a remote agent (from WS4's picker) sets the Session's `Location.workspaceID` to a value the new `RemoteLocationRunner` recognizes (e.g. `remote:<serverID>:<agentID>`).
- `SessionRunner.Interface.run({sessionID, force})`, when resolved through this Location, opens/reuses the container's chat WebSocket instead of calling a local LLM provider, and publishes `EventV2` messages equivalent to today's `publish-llm-event.ts` output so the TUI's existing rendering path requires no changes to display streamed text.
- `HandoffSentEvent`-derived frames are published as a new `EventV2` variant (e.g. `session.remote-handoff`) carrying `{source, target}`, consumed by WS4 for the "who's speaking" indicator.
- Interrupting the session (`SessionExecution.Service.interrupt`) closes the remote WS connection or sends a cancellation frame, verified by the container observing disconnect/cancel. Since handoff routing is sequential (only one participant is ever active), interrupting while a specific participant is active is, in effect, "stopping that agent" — no separate per-participant interrupt exists or is needed.
- A new `steerToAgent(agentID)` method on the remote runner sends a `steer_to_agent` frame on the existing chat WS (no new connection), used by WS4's participant-targeting UI (Decision #7). This is advisory per WS1's constraint — the method resolves once the container acknowledges receipt, not once the handoff actually occurs; the actual handoff (or lack thereof) is still observed via the normal `handoff` frame → `session.remote-handoff` event path.

**Resolution via WBS**:
1. Define `RemoteAgentConfig` schema in `packages/opencode/src/config/remote-agent.ts` following the `ConfigX` self-export pattern; wire into the root config merge. Commit: `Core: add remote agent server config schema`.
2. Define the TypeScript mirror of WS1's wire protocol in `packages/core/src/session/execution/remote-protocol.ts` (kept in sync manually with the Python `protocol.py`; note as a known cross-repo drift risk, mitigated by a comment linking both files). In the same commit, add `packages/core/test/lib/remote-agent-server.ts`, a fake in-process WS server speaking this protocol, modeled on `packages/opencode/test/lib/llm-server.ts` (scriptable queued responses) and `packages/opencode/test/plugin/openai-ws.test.ts` (real `ws`-library server-in-process pattern). Commit: `Core: add remote agent wire protocol types and fake server test helper`.
3. Implement `packages/core/src/session/execution/remote.ts` (`RemoteLocationRunner`) implementing the same runner interface as `local.ts`, translating between `SessionRunner.Interface.run` and the WS client (open connection, send `user_message`, forward `assistant_delta`/`handoff`/`turn_complete` into `EventV2` publishes via `publish-llm-event.ts`-equivalent helper). Add `packages/core/test/session-runner-remote.test.ts` in the same commit, reusing the `EventV2` capture-double pattern from `session-runner-tool-events.test.ts:14-33` against the fake server from step 2. Commit: `Core: implement remote location runner`.
4. Extend `LocationServiceMap` resolution to recognize `remote:*` workspaceIDs and route to the new runner; extend `session-runner-remote.test.ts` with a Location-resolution assertion in the same commit. Commit: `Core: route remote Location IDs to RemoteLocationRunner`.
5. Add a manifest-fetch client (`GET /agents/manifest`) used by WS4's picker, exposed as a small service function (e.g. `packages/opencode/src/remote-agent/manifest.ts`), with a colocated unit test against the fake server. Commit: `Core: add remote agent manifest client`.
6. Add `steerToAgent(agentID)` to `remote.ts`, sending the `steer_to_agent` frame on the already-open chat WS; extend `session-runner-remote.test.ts` to assert the frame is sent with the correct `agent_id` in the same commit. Commit: `Core: add steerToAgent participant targeting to remote runner`.

**Specific change surface**:
- `packages/opencode/src/config/remote-agent.ts` (new) — schema + merge wiring into whichever root config module composes `ConfigAgent`-style exports.
- `packages/core/src/session/execution/remote-protocol.ts` (new)
- `packages/core/test/lib/remote-agent-server.ts` (new — fake WS server test helper)
- `packages/core/src/session/execution/remote.ts` (new)
- `packages/core/test/session-runner-remote.test.ts` (new)
- `packages/core/src/session/execution.ts` — extend Location resolution to dispatch to `remote.ts` (exact line range to confirm at implementation time by re-reading current file).
- `packages/opencode/src/remote-agent/manifest.ts` (new, with colocated test)

---

### WS3 — remote-tool-bridge

**Goal**: When the remote MAF orchestrator's active agent issues a tool call, it actually executes against the user's local workspace through OpenCode's existing tool registry and permission gating, and the result is returned to the container.

**Problem**: No pathway exists for an external process's tool-call request to reach `packages/opencode/src/tool/registry.ts`'s local execution path.

**Investigation/root cause**: The MCP client integration (`packages/opencode/src/mcp/*`) is the only existing case of tool execution crossing a process boundary, but it runs the *opposite* direction (OpenCode calls out to an MCP server for a tool implementation); here the direction is reversed — the *remote agent* originates the call, and *OpenCode* must execute it locally. No existing code inverts this direction, so WS3 is new plumbing modeled on, not reused from, the MCP client.

**Definition of Done**:
- A `tool_call` frame received on the WS3 channel (opened by WS2's `RemoteLocationRunner`) is mapped to one of OpenCode's existing `Tool.Def` implementations (`ShellTool`, `EditTool`, `WriteTool`, `ReadTool`) based on a declared name mapping (e.g. remote `"bash"` → local `ShellTool`).
- The mapped tool executes via the same `Context`/permission (`Ruleset`) path as a local agent's own tool calls — i.e. the user sees the same permission prompt they'd see if a local subagent ran the same shell command.
- The tool's `ExecuteResult` is serialized into a `tool_result` frame and sent back over the same WS connection, unblocking the container's pending tool call.
- A remote agent's shell command run through this bridge produces an observable side effect in a real local workspace directory — proven automatically in Layer 2 against a temp directory (`packages/core/test/remote-tool-bridge.test.ts`), and again manually in Layer 4 against the user's actual workspace.
- An unmapped/disallowed remote tool name is rejected with a `tool_result` error frame rather than silently ignored or crashing the bridge.

**Resolution via WBS**:
1. Define the remote-tool-name → local `Tool.Def` mapping table in `packages/core/src/session/execution/remote-tool-bridge.ts`, with a colocated `packages/core/test/remote-tool-bridge.test.ts` asserting the mapping table itself (e.g. `"bash"` → `ShellTool`) in the same commit. Commit: `Core: add remote-to-local tool name mapping`.
2. Implement the bridge: on receiving `tool_call`, resolve the mapped `Tool.Def`, construct a `Context` scoped to the bound Session/Location (same as local tool invocation path in `registry.ts`), execute against a real temp workspace directory, and send `tool_result`; extend `remote-tool-bridge.test.ts` with the full round-trip assertion against the fake server from WS2 in the same commit. Commit: `Core: implement remote tool-call bridge execution`.
3. Ensure permission prompts route through the existing `Ruleset`/permission UI unchanged, reusing `packages/core/test/policy.test.ts`'s `AppNodeBuilder.build`/`testEffect` harness to assert `Context.ask` is invoked on the bridge path; extend `remote-tool-bridge.test.ts` in the same commit. Commit: `Core: gate remote tool calls through existing permission flow`.
4. Add rejection/error path for unmapped tool names or execution failures, with the corresponding test case added to `remote-tool-bridge.test.ts` in the same commit. Commit: `Core: add remote tool-call error handling`.

**Specific change surface**:
- `packages/core/src/session/execution/remote-tool-bridge.ts` (new)
- `packages/core/test/remote-tool-bridge.test.ts` (new)
- `packages/core/src/session/execution/remote.ts` (from WS2) — wire in the bridge on `tool_call` frame receipt.
- `packages/opencode/src/tool/registry.ts` — expose a lookup function usable by the bridge to resolve a `Tool.Def` by name outside the normal per-agent assembly path (small addition, not a rewrite).

---

### WS4 — agent-picker-ui

**Goal**: `/agent` (new) and `/agents` (existing) both open a single dialog listing agents grouped into three visually separated sections — **Native** (built-in TUI agents), **Workspace** (`.md`/config-defined agents in the project), and **Remote** (MAF containers) — using the picker's existing category-grouping mechanism. Selecting a remote entry binds the session per WS2, and the TUI shows live remote-turn status (streaming text + current handoff holder).

**Problem**: `<DialogAgent />` renders a single flat list with no grouping at all — today's `description: item.native ? "native" : item.description` (`dialog-agent.tsx:15`) only distinguishes native vs. non-native *textually* in the description column, not as a visual section. There is no remote section, no `/agent` alias, and no rendering for handoff/"who's speaking" status.

**Investigation/root cause**:
- `packages/tui/src/app.tsx:679-686` registers only `slashName: "agents"` on the existing command.
- `packages/tui/src/component/dialog-agent.tsx:1-31` (full file) renders every `local.agent.list()` entry flat, with `description: item.native ? "native" : item.description` (line 15) as the only native/non-native signal — no `category` is set on any option today.
- `packages/opencode/src/agent/agent.ts:39` — `Info.native: Schema.optional(Schema.Boolean)` is the existing flag: `true` for built-in agents (`agent.ts:154,180,194,217,222,238,254` — `build`, `plan`, `explore`, etc.), `false` for every agent instantiated from project config at `agent.ts:279` inside the `for (const [key, value] of Object.entries(cfg.agent ?? {}))` loop — i.e. every agent defined via config or `.md` frontmatter (`packages/opencode/src/config/agent.ts`, `packages/opencode/src/config/markdown.ts`) ends up `native: false`. This is the exact boundary needed for a "Native" vs. "Workspace" split — no new flag is needed, `native` already means precisely this.
- `packages/tui/src/ui/dialog-select.tsx:186-196` (`grouped` memo) — `DialogSelectOption` already has a `category`/`categoryView` field (`dialog-select.tsx:65-66`); `groupBy((x) => x.category ?? "")` renders a header per distinct category, in first-seen order, whenever `category` is non-empty (confirmed by `rows` memo at lines 204-209 which reserves header rows only `if (!category) return acc`). This is an existing, working grouping mechanism — no new UI primitive is needed, only supplying `category` per option.

**Definition of Done**:
- Typing `/agent` or `/agents` opens the same dialog; both are visible as slash suggestions in the prompt autocomplete (`packages/tui/src/component/prompt/autocomplete.tsx`).
- The dialog shows three visually distinct, separately-headed groups in this order: **Native** (agents with `native === true`), **Workspace** (agents with `native === false`, i.e. config/`.md`-defined), **Remote** (entries populated by calling WS2's manifest client for each configured `remoteAgent.servers` entry, showing name/description per orchestrator).
- Each local agent's `description` column keeps showing its actual description (not the literal string `"native"`) now that native/non-native is conveyed by the section header instead of overloading the description field — i.e. `dialog-agent.tsx`'s `description: item.native ? "native" : item.description` special-case is removed since grouping now carries that meaning.
- Selecting a remote orchestrator entry calls the session-binding action (sets Location per WS2) and closes the dialog; the next prompt submission drives the remote turn.
- While a remote turn streams, the session view shows incremental text updates (reusing existing message rendering — no new rendering surface for the text itself) plus a status line/badge showing the currently active sub-agent name, updated on each relayed handoff frame.
- Submitting a new prompt while a remote turn is in progress is accepted by the existing input component with the same steer/queue behavior local sessions already exhibit (no separate "remote busy" blocking state).
- While bound to a remote session, a new in-session action (a slash command, e.g. `/participants`, opened from the same status area as the handoff indicator) lists the current orchestrator's `participants` from the manifest and lets the user pick one to either **steer toward** (sends `steerToAgent` per WS2) or **stop** (sends the existing session interrupt — see WS2 DoD note that stopping is equivalent to interrupting the whole turn since only one participant is ever active). This action is clearly labeled as best-effort/advisory in the UI copy itself (not just in this doc), consistent with WS1's constraint that there is no hard override.

**Resolution via WBS**:
1. Add `slashAliases: ["agent"]` to the existing `agent.list` command entry in `packages/tui/src/app.tsx`. Commit: `TUI: add /agent alias to agent picker command`.
2. In `dialog-agent.tsx`, set `category: item.native ? "Native" : "Workspace"` on each local-agent option (removing the old `item.native ? "native" : item.description` description override) so the existing `DialogSelect` grouping renders the two local sections. Commit: `TUI: group agent picker into Native and Workspace sections`.
3. Fetch remote orchestrators via WS2's manifest client and append them as options with `category: "Remote"`, alongside the existing local list. Commit: `TUI: render remote agents section in agent picker`.
4. Wire remote-entry selection to the Location-binding call from WS2. Commit: `TUI: bind session to selected remote agent`.
5. Add a handoff status indicator subscribed to the new `session.remote-handoff` `EventV2` variant from WS2. Commit: `TUI: show active handoff agent indicator`.
6. Add a new `dialog-participants.tsx` (or extend the existing dialog-select usage) listing the bound orchestrator's `participants` from the manifest, with two actions per entry ("Steer here" → `steerToAgent`, "Stop" → existing interrupt), registered as `/participants` alongside the handoff indicator; label the dialog copy as best-effort. Commit: `TUI: add participant steer/stop picker for remote sessions`.

**Specific change surface**:
- `packages/tui/src/app.tsx` — add `slashAliases` to the existing command entry (confirm exact line range at implementation time), and register the new `/participants` command.
- `packages/tui/src/component/dialog-agent.tsx` — replace the flat `local.agent.list()` mapping with `category`-tagged Native/Workspace options, append Remote options from WS2's manifest client, and add remote-selection handling.
- `packages/tui/src/component/dialog-participants.tsx` (new) — participant list + steer/stop actions.
- `packages/tui/src/routes/session/index.tsx` (or nearest session-status rendering component, to confirm at implementation time) — handoff indicator.

---

### WS5 — compose-dev-env

**Goal**: A single `docker-compose.yml` (in the sprints feature folder, not committed to either product repo) spins up the WS1 container plus a local Phoenix instance for OTel, and documents the manual end-to-end verification steps for WS2-WS4's Definition of Done.

**Problem**: No reproducible way to demo the full flow end-to-end today.

**Definition of Done**:
- `docker compose up` starts the MAF handoff-bridge container and a Phoenix container; `curl localhost:<port>/agents/manifest` succeeds.
- A documented manual test script in the sprints folder walks through: configuring `remoteAgent.servers` in OpenCode, running `/agent`, selecting the container's orchestrator, sending a message that triggers a handoff between two sample agents, and observing a real local file change from a remote tool call.
- Phoenix UI independently shows the OTel trace for that same run.

**Resolution via WBS**:
1. Author `docker-compose.yml` referencing WS1's image and Phoenix's published image. Commit: `Compose: add dev environment for handoff bridge + Phoenix`.
2. Write manual verification script/doc covering the DoD statements above. Commit: `Compose: add end-to-end verification doc`.

**Specific change surface**:
- `/Users/pdops/projects/opencode/opecode-sprints/remote-maf-handoff-agents/docker-compose.yml` (new)
- `/Users/pdops/projects/opencode/opecode-sprints/remote-maf-handoff-agents/VERIFY.md` (new)

---

## Deferred / nice to have later

- Live discovery (Consul/docker-labels) instead of statically configured container URLs — deferred; static `remoteAgent.servers` config is sufficient for the PoC.
- Authenticated/mTLS-secured container endpoints — deferred; PoC assumes trusted local/dev network.
- Multi-remote-agent concurrent sessions (talking to two containers from one OpenCode session) — deferred; PoC is one remote backend per Session.
- Automatic keeping WS1's `protocol.py` and WS2's `remote-protocol.ts` in sync (e.g. codegen) — deferred; PoC accepts manual drift risk, flagged in WS2.
- Persisting remote-turn transcripts identically to local ones for replay/resume across OpenCode restarts — deferred; PoC assumes a remote session lives only as long as the WS connection.

See `requirements.md` for Goal/Problem/DoD and `wbs.md` for dependency graph, branch names, and implementation order.
