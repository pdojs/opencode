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

---

### WS1 — maf-container-server

**Goal**: A Docker container running a MAF handoff-pattern workflow exposes an HTTP+WebSocket API that OpenCode can query for its manifest, stream a chat turn from, and receive/answer tool-call requests over.

**Problem**: MAF's `Workflow`/`_handoff.py` is a Python library object with no network surface; nothing today lets an external client discover, converse with, or receive tool-call requests from a running handoff workflow.

**Investigation/root cause**: Confirmed via `_handoff.py:1-100` — the module defines `HandoffConfiguration`, `HandoffSentEvent`, and workflow-building logic (`OrchestrationWorkflowBuilder`), all consumed in-process via `agent_framework._workflows._workflow.Workflow`. No FastAPI/ASGI wrapper exists in `agent-framework` for this or any orchestration pattern (confirmed no `server`/`fastapi` hits under `packages/orchestrations`). This is new code to author, not a bug to fix.

**Definition of Done**:
- `GET /agents/manifest` returns JSON listing at least one orchestrator with `{id, name, description, participants: [{id, name}]}`.
- `WS /agents/{id}/session` accepts a JSON `{type: "user_message", text}` frame and streams back `{type: "assistant_delta", text}` frames followed by a `{type: "turn_complete"}` frame, with `{type: "handoff", source, target}` frames emitted whenever `HandoffSentEvent` fires.
- The same WS channel accepts a `{type: "tool_result", call_id, output}` frame from the client and, when the active agent's tool schema includes a `bash`/`edit`-style tool, emits `{type: "tool_call", call_id, name, arguments}` requesting the client execute it (the container does **not** execute these itself).
- OTel exporter configured via `openinference-instrumentation-agent-framework`, pointed at a Phoenix collector endpoint from container env var, independently verified in the Phoenix UI.
- `docker build` produces an image; running it standalone (`curl localhost:PORT/agents/manifest`) succeeds without OpenCode running.

**Resolution via WBS**:
1. Author `server.py` (FastAPI app) in a new `agent-framework`-adjacent sample/service directory (exact location TBD at implementation time — likely a new top-level `python/samples/05-end-to-end/opencode-handoff-bridge/` sibling to the existing `ag_ui_workflow_handoff` sample, mirroring its structure). Commit: `Container: add FastAPI manifest + WS chat server`.
2. Wire `_handoff.py`'s workflow build function into the server's session lifecycle: one workflow instance per WS connection, replaying `HandoffSentEvent` and per-agent response streaming into the wire frames defined above. Commit: `Container: bridge handoff workflow events to WS frames`.
3. Implement the tool-call request/response half of the protocol: intercept the active agent's tool invocations before local execution, emit `tool_call`, block on `tool_result` from the client with a timeout, and feed the result back into the agent's tool-call response. Commit: `Container: add tool-call bridge over WS`.
4. Add `openinference-instrumentation-agent-framework` + OTel exporter config (env-var driven collector endpoint). Commit: `Container: wire OTel export to Phoenix`.
5. Write `Dockerfile` for the server. Commit: `Container: add Dockerfile for handoff bridge server`.

**Specific change surface** (new files, exact paths finalized during implementation):
- `agent-framework/python/samples/05-end-to-end/opencode-handoff-bridge/server.py` (new)
- `agent-framework/python/samples/05-end-to-end/opencode-handoff-bridge/protocol.py` (new — wire frame Pydantic models, shared contract WS2 will mirror in TypeScript)
- `agent-framework/python/samples/05-end-to-end/opencode-handoff-bridge/Dockerfile` (new)

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
- Interrupting the session (`SessionExecution.Service.interrupt`) closes the remote WS connection or sends a cancellation frame, verified by the container observing disconnect/cancel.

**Resolution via WBS**:
1. Define `RemoteAgentConfig` schema in `packages/opencode/src/config/remote-agent.ts` following the `ConfigX` self-export pattern; wire into the root config merge. Commit: `Core: add remote agent server config schema`.
2. Define the TypeScript mirror of WS1's wire protocol in `packages/core/src/session/execution/remote-protocol.ts` (kept in sync manually with the Python `protocol.py`; note as a known cross-repo drift risk, mitigated by a comment linking both files). Commit: `Core: add remote agent wire protocol types`.
3. Implement `packages/core/src/session/execution/remote.ts` (`RemoteLocationRunner`) implementing the same runner interface as `local.ts`, translating between `SessionRunner.Interface.run` and the WS client (open connection, send `user_message`, forward `assistant_delta`/`handoff`/`turn_complete` into `EventV2` publishes via `publish-llm-event.ts`-equivalent helper). Commit: `Core: implement remote location runner`.
4. Extend `LocationServiceMap` resolution to recognize `remote:*` workspaceIDs and route to the new runner. Commit: `Core: route remote Location IDs to RemoteLocationRunner`.
5. Add a manifest-fetch client (`GET /agents/manifest`) used by WS4's picker, exposed as a small service function (e.g. `packages/opencode/src/remote-agent/manifest.ts`). Commit: `Core: add remote agent manifest client`.

**Specific change surface**:
- `packages/opencode/src/config/remote-agent.ts` (new) — schema + merge wiring into whichever root config module composes `ConfigAgent`-style exports.
- `packages/core/src/session/execution/remote-protocol.ts` (new)
- `packages/core/src/session/execution/remote.ts` (new)
- `packages/core/src/session/execution.ts` — extend Location resolution to dispatch to `remote.ts` (exact line range to confirm at implementation time by re-reading current file).
- `packages/opencode/src/remote-agent/manifest.ts` (new)

---

### WS3 — remote-tool-bridge

**Goal**: When the remote MAF orchestrator's active agent issues a tool call, it actually executes against the user's local workspace through OpenCode's existing tool registry and permission gating, and the result is returned to the container.

**Problem**: No pathway exists for an external process's tool-call request to reach `packages/opencode/src/tool/registry.ts`'s local execution path.

**Investigation/root cause**: The MCP client integration (`packages/opencode/src/mcp/*`) is the only existing case of tool execution crossing a process boundary, but it runs the *opposite* direction (OpenCode calls out to an MCP server for a tool implementation); here the direction is reversed — the *remote agent* originates the call, and *OpenCode* must execute it locally. No existing code inverts this direction, so WS3 is new plumbing modeled on, not reused from, the MCP client.

**Definition of Done**:
- A `tool_call` frame received on the WS3 channel (opened by WS2's `RemoteLocationRunner`) is mapped to one of OpenCode's existing `Tool.Def` implementations (`ShellTool`, `EditTool`, `WriteTool`, `ReadTool`) based on a declared name mapping (e.g. remote `"bash"` → local `ShellTool`).
- The mapped tool executes via the same `Context`/permission (`Ruleset`) path as a local agent's own tool calls — i.e. the user sees the same permission prompt they'd see if a local subagent ran the same shell command.
- The tool's `ExecuteResult` is serialized into a `tool_result` frame and sent back over the same WS connection, unblocking the container's pending tool call.
- A remote agent's shell command run through this bridge produces an observable side effect in the real local workspace directory (e.g. `ls` output reflects real files, `echo > file.txt` creates a real file) — proven via a manual end-to-end test, not a container-local mock.
- An unmapped/disallowed remote tool name is rejected with a `tool_result` error frame rather than silently ignored or crashing the bridge.

**Resolution via WBS**:
1. Define the remote-tool-name → local `Tool.Def` mapping table in `packages/core/src/session/execution/remote-tool-bridge.ts`. Commit: `Core: add remote-to-local tool name mapping`.
2. Implement the bridge: on receiving `tool_call`, resolve the mapped `Tool.Def`, construct a `Context` scoped to the bound Session/Location (same as local tool invocation path in `registry.ts`), execute, and send `tool_result`. Commit: `Core: implement remote tool-call bridge execution`.
3. Ensure permission prompts route through the existing `Ruleset`/permission UI unchanged (verify by reusing `Context.ask`). Commit: `Core: gate remote tool calls through existing permission flow`.
4. Add rejection/error path for unmapped tool names or execution failures. Commit: `Core: add remote tool-call error handling`.

**Specific change surface**:
- `packages/core/src/session/execution/remote-tool-bridge.ts` (new)
- `packages/core/src/session/execution/remote.ts` (from WS2) — wire in the bridge on `tool_call` frame receipt.
- `packages/opencode/src/tool/registry.ts` — expose a lookup function usable by the bridge to resolve a `Tool.Def` by name outside the normal per-agent assembly path (small addition, not a rewrite).

---

### WS4 — agent-picker-ui

**Goal**: `/agent` (new) and `/agents` (existing) both open a single dialog listing local subagents and remote MAF containers; selecting a remote entry binds the session per WS2, and the TUI shows live remote-turn status (streaming text + current handoff holder).

**Problem**: `<DialogAgent />` only lists local `Agent.Info` entries; there is no remote section, no `/agent` alias, and no rendering for handoff/"who's speaking" status.

**Investigation/root cause**: `packages/tui/src/app.tsx:679-686` registers only `slashName: "agents"` on the existing command; `packages/tui/src/component/dialog-agent.tsx` renders only `Agent.Service.list()`. Confirmed no remote-section concept exists.

**Definition of Done**:
- Typing `/agent` or `/agents` opens the same dialog; both are visible as slash suggestions in the prompt autocomplete (`packages/tui/src/component/prompt/autocomplete.tsx`).
- The dialog shows a "Remote Agents" section populated by calling WS2's manifest client for each configured `remoteAgent.servers` entry, showing name/description per orchestrator.
- Selecting a remote orchestrator entry calls the session-binding action (sets Location per WS2) and closes the dialog; the next prompt submission drives the remote turn.
- While a remote turn streams, the session view shows incremental text updates (reusing existing message rendering — no new rendering surface for the text itself) plus a status line/badge showing the currently active sub-agent name, updated on each relayed handoff frame.
- Submitting a new prompt while a remote turn is in progress is accepted by the existing input component with the same steer/queue behavior local sessions already exhibit (no separate "remote busy" blocking state).

**Resolution via WBS**:
1. Add `slashAliases: ["agent"]` to the existing `agent.list` command entry in `packages/tui/src/app.tsx`. Commit: `TUI: add /agent alias to agent picker command`.
2. Extend `dialog-agent.tsx` to fetch and render a "Remote Agents" section via WS2's manifest client, alongside the existing local list. Commit: `TUI: render remote agents section in agent picker`.
3. Wire remote-entry selection to the Location-binding call from WS2. Commit: `TUI: bind session to selected remote agent`.
4. Add a handoff status indicator subscribed to the new `session.remote-handoff` `EventV2` variant from WS2. Commit: `TUI: show active handoff agent indicator`.

**Specific change surface**:
- `packages/tui/src/app.tsx` — add `slashAliases` to the existing command entry (confirm exact line range at implementation time).
- `packages/tui/src/component/dialog-agent.tsx` — add remote section + selection handler.
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
