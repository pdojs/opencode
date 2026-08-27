# Remote MAF Handoff Agents in OpenCode — WBS

## WBS0 — write planning artifacts to opecode-sprints (this step)

**Goal**: The plan exists as versioned files in `/Users/pdops/projects/opencode/opecode-sprints/remote-maf-handoff-agents/` before any implementation work starts.

**Steps**:
1. Create `requirements.md`, `design-proposal.md`, `wbs.md` in this folder. (done)
2. Commit in the `opencode` repo (this folder lives inside its working tree): `docs: add remote MAF handoff agents plan`.

This is a documentation-only step with no source-code change surface in `opencode` or `agent-framework`.

## Dependency graph

```
WS1 (maf-container-server)     — independent (Python/container side)
WS2 (remote-location-runner)   — depends on WS1's wire protocol (manifest + chat WS shape)
WS3 (remote-tool-bridge)       — depends on WS2 (needs the runner/session plumbing in place)
WS4 (agent-picker-ui)          — depends on WS2 (needs a runner to bind to), can start once WS2's client interface is stubbed
WS5 (compose-dev-env)          — depends on WS1, WS2, WS3 (end-to-end wiring to demo)
```

Parallelism: WS1 can start immediately and fully independently. WS2 can start once WS1's manifest/chat WS message shapes are drafted (does not need WS1 fully implemented, just the contract). WS4 can be stubbed against a fake client in parallel with WS2/WS3. WS5 is last — integration/demo only.

## Branch names

Actual branching used during implementation supersedes the original plan below (see
"Implementation status" at the end of this file for why): PRs go `story/<workstream> ->
feature/remote-maf-handoff-agents -> dev`, not directly to `dev`, and `dev/<story>` branch
names are not possible in this repo (see status note). Original per-workstream naming, kept
for reference:

- `maf-container-server` (WS1) — **implemented as a standalone Python app**, not a branch in
  `agent-framework`. Now its own `remote-maf-handoff-agents` repo. See status note.
- `remote-location-runner` (WS2, in `opencode` repo)
- `remote-tool-bridge` (WS3, in `opencode` repo)
- `agent-picker-ui` (WS4, in `opencode` repo)
- `compose-dev-env` (WS5, sprints-folder only, no product-repo branch needed)

## Recommended implementation order

1. WS1 (maf-container-server) — no dependencies, unblocks everything else's contract.
2. WS2 (remote-location-runner) — needs only WS1's drafted wire-frame shapes, not a finished container.
3. WS3 (remote-tool-bridge) — depends on WS2's runner/session plumbing existing.
4. WS4 (agent-picker-ui) — can start in parallel with WS3 once WS2 exposes a manifest client + Location-binding call.
5. WS5 (compose-dev-env) — last, integrates all of the above for a working demo.

WS5's `VERIFY.md` should reference `test-requirements.md`'s three demo scripts (Demo 1 basic
path, Demo 2 + steer/stop, Demo 3 + participant targeting) directly rather than duplicating
their steps; author `VERIFY.md` as a short pointer plus environment-specific setup notes.

See `requirements.md` for Goal/Problem/Decisions/DoD, `design-proposal.md` for investigation,
root cause, and per-workstream resolution/change surfaces, and `test-requirements.md` for the
three demo scripts used to validate the DoD end-to-end.

## Implementation status

Deviations from the original plan, made explicitly when implementation started:

- **Branching model**: implementation branches are named `story/<workstream>` (not
  `dev/<workstream>`) because this repo already has a literal branch named `dev` — git refs
  cannot have both `refs/heads/dev` and `refs/heads/dev/<anything>` simultaneously
  (`cannot lock ref ... 'refs/heads/dev' exists`). Each story branch is pushed and PR'd against
  `feature/remote-maf-handoff-agents` (created off `dev`), not directly against `dev`. That
  feature branch will eventually be merged to `dev` once all workstreams land.
- **WS1 location**: rather than a branch inside the `agent-framework` checkout, WS1 was built
  as a standalone Python app, initially at `test/remote-maf-handoff-agents/` inside the
  `opencode` repo (per explicit instruction — "create a new test folder with the agentic app
  source code there; we will eventually move this test case out of this workspace"). It depends
  on the published PyPI packages `agent-framework-core`/`agent-framework-orchestrations`/
  `agent-framework-openai`, not a local path dependency on the `agent-framework` checkout, so
  it is portable and can be extracted into its own repo later without modification.
  **That extraction has since happened**: the app now lives in its own
  `remote-maf-handoff-agents` repo, expected checked out beside `opencode`. Every
  `remote-maf-handoff-agents/...` path in this document is relative to that repo. The port
  needed no code changes, as anticipated — only `docker-compose.yml`'s build context, which
  now defaults to `../../../remote-maf-handoff-agents` and honours `BRIDGE_CONTEXT`.
- **WS1 status**: implemented and merged into `story/maf-container-server`
  (PR: `feature/remote-maf-handoff-agents` <- `story/maf-container-server`, 3 commits — manifest
  + chat + tool bridge, OTel wiring, Dockerfile/README). 5/5 Layer 1 contract tests passing
  (`python -m pytest tests/ -q` in `remote-maf-handoff-agents/`). `docker build` itself was
  not exercised (no Docker daemon in the authoring environment) — packaging was instead
  verified via a non-editable `pip install .`; re-verify `docker build` before relying on the
  image for Layer 4 manual demos. **Merged (squash) into `feature/remote-maf-handoff-agents`.**
- **WS2 location deviation**: `RemoteLocationRunner` lives at
  `packages/core/src/session/runner/remote.ts`, not `packages/core/src/session/execution/remote.ts`
  as originally planned. The actual (post-V2-refactor) architecture already routes *all*
  Location-scoped runner resolution generically through `execution/local.ts`'s coordinator +
  `LocationServiceMap.get(session.location)` — there is only ever one `SessionExecution.Service`
  implementation regardless of runner type, so no second execution-layer file was needed. The
  new runner satisfies `SessionRunner.Interface` directly and is swapped in via
  `buildLocationServiceMap`'s existing `replacements` mechanism in `location-services.ts`,
  keyed on a `remote:<serverID>:<orchestratorID>` `workspaceID` prefix.
- **WS2 status**: implemented on `story/remote-location-runner`
  (PR: `feature/remote-maf-handoff-agents` <- `story/remote-location-runner`, 6 commits — config
  schema, protocol mirror, runner, LocationServiceMap wiring, manifest client, decode-`Option`
  bugfix, `steerToAgent`). 16 new tests passing (`remote-protocol.test.ts`,
  `session-runner-remote.test.ts`, `remote-agent-manifest.test.ts`); full `packages/core` suite
  at 1104/1112 (remaining 8 failures are pre-existing Mistral/xAI/Groq reasoning-effort tests,
  confirmed present before this branch's changes). `bun run typecheck` clean. `steerToAgent`
  (Decision #7 in `requirements.md`/`design-proposal.md`) is implemented as a module-level
  export (not a `Service` method) backed by a module-scoped `Map<SessionID, RemoteConnection>` —
  this lets WS4's future participant-picker action call it directly without needing to resolve
  the Location's Effect layer first; it sends the `steer_to_agent` frame on the Session's
  already-open chat WS and no-ops (`false`) if no connection is open yet. Known simplifications
  carried into WS3/WS4: handoff notices render as inline text (no dedicated `EventV2` variant
  yet), remote tool calls get a stubbed error `tool_result` (WS3's job to actually bridge them),
  and interrupting a remote turn closes its WS connection outright (MAF's workflow has no
  resume-by-id API, so the next turn starts a fresh remote conversation instead of resuming the
  interrupted one). **Deferred from the original WS2 WBS step 2**: a fake in-process WS server
  test helper (`packages/core/test/lib/remote-agent-server.ts`) modeled on
  `packages/opencode/test/lib/llm-server.ts` was not built this pass — WS2's tests instead cover
  protocol encode/decode, workspace-ID parsing, the manifest HTTP client, and `steerToAgent`'s
  no-connection no-op path in isolation, without a live WS integration test of `runTurn`/`run`
  end-to-end. This gap is deferred to WS5's compose-based e2e demo, or a follow-up integration
  test if higher confidence is needed before then.
- **WS3 location deviation**: `remote-tool-bridge.ts` lives at
  `packages/core/src/session/runner/remote-tool-bridge.ts`, not
  `packages/core/src/session/execution/remote-tool-bridge.ts` as originally planned — same
  reasoning as WS2's runner-location deviation (no second execution-layer file exists). It also
  targets the *current* `packages/core/src/tool/*` canonical tool architecture
  (`ToolRegistry.Service.materialize(permissions).settle(...)`, per
  `packages/core/src/tool/AGENTS.md`), not the `packages/opencode/src/tool/registry.ts`
  `Tool.Def`/`ExecuteResult` shape the original plan cited — that older shape no longer exists in
  this form. No changes were needed in `packages/opencode/src/tool/*` at all: the current
  registry already exposes the exact `materialize()`/`settle()` surface the bridge needs.
- **WS3 status**: implemented on `story/remote-tool-bridge`
  (PR: `feature/remote-maf-handoff-agents` <- `story/remote-tool-bridge`). Adds a
  `run_local_command` → `bash` name/input mapping, wires `ToolRegistry.Service` into
  `SessionRunnerRemote.node`'s deps, and replaces the WS2-era tool-call stub in `runTurn` with a
  real `materialize().settle(...)` call — the same registry, permission gating
  (`PermissionV2.Service`, captured inside each built-in tool's own layer), and settlement path a
  local agent's own tool calls go through. The `tool_call` case now also publishes a synthetic
  `LLMEvent.toolCall`/`LLMEvent.toolResult` pair through the same publisher used for text, so the
  TUI's existing tool-call rendering (permission prompts, tool-result cards) needs zero changes
  to display a remote tool call — the same "zero rendering changes" property WS2 established for
  text. 4 new unit tests (`remote-tool-bridge.test.ts`) against a fake `ToolRegistry.Interface`
  cover: unmapped-name rejection (without calling the registry), correct name/input mapping for
  `run_local_command`, and both branches of `resultText()`. Full `packages/core` suite at
  1112/1120 passing (same 8 pre-existing Mistral/xAI/Groq failures, unrelated). `bun run
  typecheck` clean. **Deferred, same as WS2**: no end-to-end test exercises a real `bash`
  execution or permission prompt through a live WS connection — remains open for WS5's
  compose-based demo or a dedicated follow-up integration test.
- **Next**: WS4 (`agent-picker-ui`) — TUI `/agent` alias, Native/Workspace/Remote grouped picker
  sections, remote-selection binding, and the handoff/participant-status indicator.
- **WS4 status**: implemented on `story/agent-picker-ui`
  (PR: `feature/remote-maf-handoff-agents` <- `story/agent-picker-ui`). Adds `slashAliases:
  ["agent"]` to the existing `agent.list` command in `packages/tui/src/app.tsx` (per Decision #4:
  `/agent` opens the same `<DialogAgent />` dialog as `/agents`, no second dialog implementation).
  A new experimental HttpApi group (`packages/opencode/src/server/routes/instance/httpapi/groups
  /remote-agent.ts` + `handlers/remote-agent.ts`, wired into `InstanceHttpApi`/`server.ts`)
  exposes `GET /experimental/remote-agent` (lists configured `remote_agent.servers`, each with its
  live-fetched manifest or a per-server fetch-error string via `RemoteAgentManifest.fetchManifest`)
  and `POST /experimental/remote-agent/select` (binds `sessionID` to
  `remote:<serverID>:<orchestratorID>` via `Session.Service.setWorkspace`, reusing WS2's
  `SessionRunnerRemote.remoteWorkspaceID`). `dialog-agent.tsx` now renders three `DialogSelect`
  categories — "Native" (`item.native`), "Workspace" (config/`.md`-defined local agents), and
  "Remote" (one entry per orchestrator across all configured servers) — satisfying the visual
  native/workspace/remote separation the user asked for, using `DialogSelect`'s existing
  `category` grouping (no new grouping primitive built). Selecting a remote entry calls the new
  `select` endpoint and shows a toast on failure instead of silently no-op'ing.
  `bun run generate` (packages/client) confirmed the experimental HttpApi surface is intentionally
  excluded from that codegen (same as `workspace`/`mcp`); the actual typed client surface used by
  the TUI is `packages/sdk/js` (`./script/build.ts`), regenerated to add
  `sdk.client.experimental.remoteAgent.{list,select}`. New test:
  `packages/opencode/test/server/httpapi-remote-agent.test.ts` (2 tests: manifest-fetch-error
  surfacing through `list`, `RemoteAgentServerNotFoundError` 400 through `select`). `bun run
  typecheck` clean across `core`, `opencode`, `tui`, and `sdk/js`. Full `packages/opencode` suite:
  3309/3341 passing; the 9 failures are pre-existing/environmental (bare-repo git tests fail on
  this machine's `safe.bareRepository` git config, Vertex/Mistral/midstream-retry/SSE tests are
  flaky under full-suite ordering — reproduced failing before this branch's changes and passing
  again in isolation), none touch remote-agent code. **Deferred from this pass**: the "who's
  currently speaking" live handoff-status badge in the session view — WS2's inline-text handoff
  notices (`↪ handoff: source → target`, rendered as ordinary assistant text) already satisfy the
  DoD's "who's speaking" requirement without a dedicated status component; a follow-up can add a
  persistent badge if inline text proves insufficient during WS5's demo. Merged: PR #5
  (`story/agent-picker-ui` -> `feature/remote-maf-handoff-agents`, squash), 4 commits (routes,
  sdk regen, TUI dialog, docs).
- **Post-WS4 architecture confirmation**: in response to a design question about aligning with
  Azure API Center's agent-registration model, verified (with `server.py:43-61` citations) that
  WS1-WS4 already implement the "container = agent host with a router + streaming API"
  shape — no code change or new workstream follows. Documented in `design-proposal.md`. Merged:
  PR #6 (`story/agent-service-architecture-note` -> `feature/remote-maf-handoff-agents`, squash,
  docs-only).
- **Merge-strategy note** (in response to a user question about squash commit size): each
  `story/*` -> `feature/remote-maf-handoff-agents` merge uses `gh pr merge --squash
  --delete-branch=false` deliberately, per this repo's own commit-discipline convention
  ("squashing is reserved for merge-to-feature (at the PR gate), not for work within the dev
  branch"). Granular, individually-buildable commits live on the retained `story/*` branches
  (not deleted); `feature/remote-maf-handoff-agents`'s history is one clean, already-tested
  commit per workstream (WS1-WS4 + the doc addendum = 5 commits total so far). `feature/... ` is
  **not yet merged into `dev`** — that happens once WS5 lands, as one final epic-level PR.
- **WS5 status**: implemented on `story/compose-dev-env` (PR #8, squash-merged into
  `feature/remote-maf-handoff-agents`). Adds `opecode-sprints/remote-maf-handoff-agents/docker-compose.yml`
  (bridge service builds WS1's Dockerfile, requires `OPENAI_API_KEY`, points
  `PHOENIX_COLLECTOR_ENDPOINT` at a `phoenix` service using the official `arizephoenix/phoenix:latest`
  image on `:6006`/`:4317`, no Postgres needed for this PoC) and `VERIFY.md` (the Layer 4 manual
  demo script, adapting `test-requirements.md`'s Demo 1/2/3 tables into concrete steps against a
  real local OpenCode build + workspace directory). **Verification limits disclosed in
  VERIFY.md itself** rather than glossed over: (1) `docker-compose config` validated the compose
  file's schema/references successfully, but `docker compose up --build` was not run end-to-end
  in this environment (no live Docker daemon available — same gap already disclosed for WS1's
  `docker build`); (2) Demo 3 rows 11/14 (participant steer/stop via `/participants`) remain
  blocked on WS4's deferred participant picker and are explicitly called out as not-yet-runnable
  rather than marked passed.
- **All planned workstreams (WS1-WS5) are now implemented and merged into
  `feature/remote-maf-handoff-agents`.** Remaining before this epic can merge to `dev`: (a) a
  live-daemon run of WS5's `docker compose up --build` plus Demos 1-2 from `VERIFY.md`
  end-to-end; (b) the deferred `/participants` picker (WS4 follow-up) to unblock Demo 3 rows
  11/14; (c) a final `feature/remote-maf-handoff-agents` -> `dev` PR once (a)/(b) are done or
  explicitly accepted as follow-up work.
- **Dogfooding Demo 1 surfaced 3 real runtime bugs never caught by code-only review**, since
  none of WS1-WS4's automated tests actually exercised a live Docker daemon + a real OpenCode
  server + a real OpenAI key together. Fixed across two PRs:
  - PR #10 (`story/bridge-runtime-fixes`, squash): (1) `telemetry.py` imported a nonexistent
    `AgentFrameworkInstrumentor` from `openinference-instrumentation-agent-framework` — the
    installed package only exports `AgentFrameworkToOpenInferenceProcessor`, a `SpanProcessor`
    subclass, not an instrumentor; fixed by registering it as the first span processor (before
    the OTLP `BatchSpanProcessor`, since processor order matters — it mutates span attributes
    in `on_end()` before the next processor exports them). (2) `OpenAIChatClient()` has no
    default model and raises `SettingNotFoundError` without one; fixed by defaulting to
    `gpt-4o-mini` via `OPENAI_CHAT_MODEL` (also keeps the demo cheap to run).
  - PR #11 (`story/remote-agent-runtime-fixes`, squash): (3) `WorkspaceV2.ID`'s branded schema
    (`packages/schema/src/workspace-id.ts`) only accepted `wrk`-prefixed strings, but
    `SessionRunnerRemote.remoteWorkspaceID()` deliberately produces `remote:<serverID>:<orchestratorID>`
    sentinel strings for the exact same `Location.workspaceID` field — this made
    `POST /experimental/remote-agent/select` throw on every call, i.e. remote-agent binding was
    completely non-functional as merged in WS4. Fixed by widening the schema check to accept
    either prefix. (4) MAF's `HandoffBuilder.build()` requires every participant `Agent` to set
    `require_per_service_call_history_persistence=True`; the sample orchestrator never set it,
    crashing the bridge on every WS session connect. Fixed by passing the flag in
    `orchestrator.py`.
  - **Verified fixed end-to-end**: created a session via `/api/session`, bound it via
    `/experimental/remote-agent/select` (200, `workspaceID: "remote:demo-bridge:support"`), sent
    a billing question via `/api/session/{id}/prompt`, and observed a real streamed assistant
    message showing a live `triage -> billing` handoff relayed back into the session — the full
    OpenCode -> RemoteLocationRunner -> bridge WS -> MAF handoff workflow -> OpenAI -> session
    message path works. Phoenix UI (`localhost:6006`) confirmed reachable for trace verification.
  - **Lesson**: WS1-WS4's test suites were correctly scoped to their own layer (unit/API-shape
    tests), but none of them constituted a true Layer-4 (`VERIFY.md`) live run until this
    dogfooding pass — that gap is exactly what Layer 4 exists to catch, and it did.

## WS8 - Rendering remote turns in the TUI (deviation from requirements.md:36)

### Problem

With PR #14 and PR #15 merged, `/agent` listed remote orchestrators, selection bound the
Session, and the bridge answered correctly — but the TUI showed **nothing** for a remote turn.

### Preliminary investigation and root cause

The whole feature as built through WS1-WS4 is V2-native: `SessionV2.prompt(...)` ->
`SessionExecution` -> `SessionRunnerRemote` -> `EventV2`. The TUI is not.

- `packages/tui/src/context/sync.tsx` renders the timeline from V1 events only: `message.updated`
  (line 321) and `message.part.updated` (line 376), loading history via `sdk.client.session.messages`
  (line 603, V1). `packages/tui/src/context/data.tsx:430` has V2 accessors, but they are consumed
  only by `prompt/autocomplete.tsx`, never by the timeline.
- `createLLMEventPublisher` (`packages/core/src/session/runner/publish-llm-event.ts:54`) publishes
  V2 `SessionEvent.*`. V1 parts come from `Session.updatePart`
  (`packages/opencode/src/session/session.ts:637`), which the V2 remote runner never calls.
- Confirmed empirically: `GET /session/{id}/message` returned `[]` for a remote Session while
  `GET /api/session/{id}/message` returned the full remote transcript.
- `EventV2Bridge` (`packages/opencode/src/event-v2-bridge.ts`) does re-emit every EventV2 onto
  `GlobalBus`, so the events reach the TUI over SSE — but `sync.tsx` has no case for V2 event
  types and drops them.

Note the non-obvious SDK mapping this hides behind: `sdk.client.session.*` is class `Session2`
(V1 `/session/{id}/message`); `sdk.client.v2.session.*` is class `Session3`
(V2 `/api/session/{id}/prompt`).

### Options considered

- **A. Server-side V1 -> V2 delegation.** Leaves rendering broken for the same reason as B.
- **B. Dispatch remote prompts from the TUI to `sdk.client.v2.session.prompt`.** Implemented,
  then reverted: it makes the turn run correctly and render *nothing*.
- **D. Full V2 -> V1 event projection.** ~12+ event types plus message lifecycle. Correct
  long-term, disproportionate for a PoC.
- **C. Substitute the V1 LLM stream (chosen).** `SessionLLM.Interface.stream`
  (`packages/opencode/src/session/llm.ts`) is a clean single seam — `processor.ts:640` is its only
  non-title call site — and `processor.ts` already consumes standard `LLMEvent`s. Substituting it
  reuses **all** existing V1 persistence, tool execution, permissions, steering, abort and TUI
  rendering.

### Deviation from requirements.md:36

`requirements.md:36` states remote prompts are "admitted through the normal `SessionV2.prompt(...)`
durable-input path". That remains true of the V2 entry point, which is unchanged and still works.
This workstream **adds** a V1 entry point because the TUI has no V2 renderer. The V2 path is the
intended destination; the V1 substitution is what makes the PoC demonstrable today.

### Resolution

1. `ConfigV1.Info` gained `remote_agent`. The V1 config service parsed `opencode.json` with a
   schema that dropped the key, and core's `Config` (which has it) is a **Location node** — adding
   it to the V1 `LLM.node` deps fails at boot with `Unbound layer node: @opencode/Location`.
2. `SessionRunnerRemote` exports `Connection` / `openConnection` / `closeConnection` /
   `serverURLFromConfig`, so the V1 path drives the *same* per-Session socket. One MAF workflow
   instance per Session, no racing conversations.
3. `packages/opencode/src/session/llm/remote-stream.ts` translates bridge frames to `LLMEvent`s.
   Handoffs become an inline `↪ handoff: a → b` text segment, matching the V2 runner.
4. `prompt.ts` derives the target from the Session's workspace sentinel and labels the assistant
   message with the bound orchestrator instead of the never-called local model.

### Two non-obvious behaviours this required

- **Tools execute inside the bridge stream, not in the V1 loop.** The V1 loop only runs tools the
  provider itself invoked, and it runs them *after* the stream ends — but the orchestrator blocks
  awaiting `tool_result` on the live socket, so ending the stream at the tool call deadlocked the
  turn (observed as a `bash` part stuck `running`, then `Tool execution aborted`). The bridge now
  invokes the mapped local tool inline, through the same permission-gated `SessionTools`
  definition a local turn uses, and answers the socket before resuming frame consumption.
- **Tool parts must be marked `providerExecuted`.** `SessionPrompt`'s loop-exit check
  (`prompt.ts:1108`) keeps looping while the assistant has tool parts lacking that flag. Without
  it the same turn replayed ~50 times until the step cap — each replay re-prompting the
  orchestrator and re-running the local tool.

### Definition of Done - verified

- `POST /session/{id}/message` (V1) on a remote-bound Session returns an assistant message with
  `providerID: "remote-agent"`, `agent: "support"` and `finish: "stop"`. Verified.
- `GET /session/{id}/message` (V1) returns exactly 2 messages for one prompt, with `step-start`,
  a completed `bash` tool part, text and `step-finish`. Verified — previously 52.
- A remote agent's `run_local_command` really executes in the local workspace: `cat marker.txt`
  returned `hello-from-workspace` from `/tmp/maf-demo-workspace/marker.txt`. Verified.
- A second prompt in the same Session continues the same remote conversation and shows a live
  `↪ handoff: triage → refunds`. Verified.
- `packages/opencode/test/session/llm-remote-stream.test.ts` covers frame translation against a
  real WebSocket stub. 2 pass.

## WS9 — `/participants` steering picker (Demo 3)

### Goal

A user driving a remote-bound session can pick any participant of the bound orchestrator and
have the in-flight turn handed off to it, seeing the handoff render inline.

### Problem

WS4 deferred the `/participants` picker, so `SessionRunnerRemote.steerToAgent` had no call site
and `VERIFY.md` recorded Demo 3 rows 11-14 as blocked.

### Preliminary investigation and root cause

- `steerToAgent` (`packages/core/src/session/runner/remote.ts`) was implemented and unit-tested
  but had zero non-test callers — an orphaned export.
- It was reachable from any entry point because `connections` is a module-level
  `Map<SessionSchema.ID, RemoteConnection>`, not Location-scoped, so no Location plumbing was
  needed to expose it over HTTP.
- The sample bridge turns a `steer_to_agent` frame into *turn text* and enqueues it as a new
  turn (`remote-maf-handoff-agents/app/server.py` `_frame_to_turn_text`, which returns
  `"The user has requested you hand off to '<id>' now."`). It does **not** redirect the
  in-flight turn.
- That last point was the latent bug: `remote-stream.ts`'s relay settled on the first
  `turn_complete`, so the steer-induced turn's frames were left in `RemoteConnection`'s buffer
  and consumed by the *next* prompt's relay. Reproduced live: after a mid-turn steer, a
  follow-up "What is 2+2?" returned the steered turn's handoff chatter instead of "4".

### Definition of Done

- `/participants` appears in the command palette only for remote-bound sessions.
- Selecting a participant mid-turn produces an inline `↪ handoff: … → …` marker and the
  picked agent's reply within the same assistant message.
- Selecting one with no turn in flight shows a "Nothing to steer" warning and sends nothing.
- A prompt sent after a steer is answered on its own merits (no stale-frame replay).

### Resolution via WBS

1. Add `POST /experimental/remote-agent/steer` to the experimental HttpApi group and handler.
   Commit: `feat(server): add a remote-agent steer endpoint`.
2. Regenerate the legacy JS SDK. Commit: `chore(sdk): regenerate types for the remote-agent steer endpoint`.
3. Add `DialogParticipants` and register `/participants`, hidden unless remote-bound.
   Commit: `feat(tui): add a /participants picker for steering remote agents`.
4. Cover the undelivered path. Commit: `test(server): cover the undelivered remote-agent steer path`.
5. Track turn lifecycle on `RemoteConnection` so steers are only sent mid-turn and the relay
   absorbs each steer-induced turn. Commit: `fix(core): stop steer frames stranding an orphan remote turn`.

### Specific change surface

- `packages/opencode/src/server/routes/instance/httpapi/groups/remote-agent.ts` — `SteerPayload`,
  `SteerResponse`, `RemoteAgentPaths.steer`, `steer` endpoint.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/remote-agent.ts` — `steer`
  handler, registered via `.handle("steer", steer)`.
- `packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts` — regenerated.
- `packages/tui/src/component/dialog-participants.tsx` — new `DialogParticipants`.
- `packages/tui/src/app.tsx` — imports `DialogParticipants` and `parseRemoteWorkspaceID`, adds
  the `remoteBinding` memo and the `agent.participants` command entry.
- `packages/core/src/session/runner/remote.ts` — `RemoteConnection.beginTurn/endTurn/steer/
  consumeSteerTurn`; `steerToAgent` delegates to `steer`.
- `packages/opencode/src/session/llm/remote-stream.ts` — `beginTurn()` before the first frame,
  `Effect.ensuring(endTurn)` on the relay fiber, `consumeSteerTurn()` gate on `turn_complete`.

### Verified

- 3 `httpapi-remote-agent` tests and 3 `llm-remote-stream` tests pass, including a steer
  choreography test asserting one step-start/step-finish pair and a refused post-turn steer.
- Live against the Docker bridge: idle steer → `{"delivered":false}`; mid-turn steer →
  `{"delivered":true}` followed by `↪ handoff: triage → refunds` and the refunds agent's reply
  inside one assistant message; a following "What is 2+2?" answered `4`.

---

## WS10 — address-any-agent (added after WS9)

### Goal

`/agent` lists every agent in a remote handoff network — the orchestrator *and* each of its
participants — and selecting any one of them binds the session so the conversation starts at
that agent.

### Problem

`/agent` listed only orchestrators, so the user could only ever enter a network through its
default start agent (`triage`). Asking the orchestrator "which agents are helping you?" returned
prose, not a selectable roster: the sub-agents were invisible and unaddressable.

### Preliminary investigation and root cause

Three hard-coded assumptions, one per layer:

1. `remote-maf-handoff-agents/app/orchestrator.py` — `_build_sample_support_workflow` called
   `.with_start_agent(triage)` unconditionally, and `OrchestratorSpec.build` took only
   `run_local_command`, so nothing could express "start elsewhere".
2. `packages/core/src/session/runner/remote.ts` — the sentinel was `remote:<server>:<orchestrator>`
   with a two-part parser (`indexOf(":")`), so a participant had nowhere to live. `openConnection`
   cached per session ID alone, so a rebind would silently reuse a socket already fixed to the
   old start agent.
3. `packages/tui/src/component/dialog-agent.tsx` — the remote section mapped
   `server.manifest.orchestrators` one-to-one, dropping `orchestrator.participants` entirely.

The manifest already carried `participants`, but only as `{id, name}` with `name == id`, so even
surfacing them would have produced an unreadable list.

### Definition of Done

- `GET /agents/manifest` returns each participant with a human-readable `name` and `description`.
- Running `/agent` shows one entry per orchestrator and one per participant, grouped under a
  `Remote · <orchestrator>` heading.
- Selecting a participant sets `workspaceID` to `remote:<server>:<orchestrator>:<participant>`.
- Prompting that session is answered by the selected participant, and the assistant message and
  status bar are labelled with the participant's id, not the orchestrator's.
- Selecting a different participant on a live session reconnects rather than reusing the socket.
- Selecting an orchestrator with no participant keeps working unchanged (start agent as before).
- An unknown participant is rejected by both the select endpoint and the bridge WebSocket.

### Resolution via WBS

1. Accept `?start_agent=` on the bridge session WebSocket; validate against `participant_ids` and
   close 4404 when unknown. Commit: `feat(bridge): let a session start on any participant in the network`.
2. Extend the sentinel to an optional third segment, send it as `start_agent`, and reconnect when
   the target changes. Commit: `feat(core): address a single participant via the remote workspace sentinel`.
3. Regenerate the SDK. Commit: `chore(sdk): regenerate types for the remote-agent participant selector`.
4. Emit a picker entry per participant and label the bound agent.
   Commit: `feat(tui): list and select every agent in a remote handoff network`.

### Specific change surface

- `remote-maf-handoff-agents/app/server.py` — `session(...)` takes `start_agent`, validates it,
  passes it to `spec.build`.
- `remote-maf-handoff-agents/app/orchestrator.py` — `OrchestratorSpec.build` takes
  `start_agent`; new `participant_details` field feeds names/descriptions into `manifest_entry()`;
  `_build_sample_support_workflow` resolves the start agent from an `agents` dict.
- `remote-maf-handoff-agents/app/protocol.py` — `Participant.description`.
- `packages/core/src/session/execution/remote-protocol.ts` — mirrors `Participant.description`.
- `packages/core/src/session/runner/remote.ts` — `remoteWorkspaceID`/`parseRemoteWorkspaceID` take
  the participant segment (split-based, replacing `indexOf`); `toWebSocketURL` appends
  `?start_agent=`; `connections` keys a `{url, connection}` pair so `openConnection` closes and
  reopens on target change; `connectionFor` threads `participantID`.
- `packages/opencode/src/session/llm/remote-stream.ts` — `Target.participantID`, forwarded to
  `openConnection`.
- `packages/opencode/src/session/prompt.ts` — `remoteLabel` prefers the participant for the
  assistant message's `agent`/`mode`/`modelID`.
- `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/remote-agent.ts` —
  optional `participantID` on `SelectPayload`, validated against the live manifest.
- `packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts` — regenerated.
- `packages/tui/src/util/remote-agent.ts` — participant-aware parser.
- `packages/tui/src/component/dialog-agent.tsx` — an option per participant; participant-aware
  `currentRemote` highlight; `participantID` sent on select.
- `packages/tui/src/component/prompt/index.tsx` — status bar names the bound participant.

### Verified

- 7 bridge tests pass, including a new pair asserting `?start_agent=gamma` starts at `gamma`
  (where the default is `alpha`) and that an unknown participant is refused with 4404.
- `bun typecheck` clean in `core`, `opencode`, and `tui`; 4 TUI and 6 core sentinel tests pass.
- Live against the rebuilt Docker bridge: the manifest lists Triage/Billing/Refunds with
  descriptions; selecting `refunds` yields `remote:demo-bridge:support:refunds` and a turn
  labelled `agent: refunds` answering "You're speaking with a refunds agent…"; re-selecting
  `billing` on the same session reconnects and answers as billing; `participantID: "nope"` is
  rejected; omitting `participantID` still yields `remote:demo-bridge:support`.

---

## WS11 — telemetry-message-content (added after WS10)

### Goal

Phoenix shows what the agents actually said and did, not just the shape of each run.

### Problem

The Phoenix trace tree rendered correctly — spans, durations, token counts, the handoff
structure — but every message pane was empty. Agent inputs and outputs were never reaching
OpenTelemetry at all.

### Preliminary investigation and root cause

Agent Framework splits telemetry into two independent switches, and `docker-compose.yml` set
only the first:

| Switch | Read by | Default | Governs |
| --- | --- | --- | --- |
| `PHOENIX_COLLECTOR_ENDPOINT` | `app/telemetry.py:28` | unset | whether spans are exported at all |
| `ENABLE_SENSITIVE_DATA` | `agent_framework/observability.py:1108` | **false** | whether spans carry message content |

`ObservabilitySettings.enable_sensitive_data` defaults to `False`
(`observability.py:1108`), and every content emission is gated behind the derived
`SENSITIVE_DATA_ENABLED` property (`observability.py:1203`) — message capture at
`observability.py:2010/2141/2186/2352/2490`, and tool arguments/results in `_tools.py:761/777/791`.

`enable_instrumentation`, by contrast, *does* default to `True` (`observability.py:1107`), which
is why spans appeared at all and masked the missing half. The pre-existing comment in
`telemetry.py` asserting that agent_framework instrumentation is "enabled by default" was
therefore true but incomplete, and read as if nothing further was required.

`OBSERVABILITY_SETTINGS` is an eager module-level singleton (`observability.py:1477`)
constructed when `agent_framework` is first imported, so the setting can only be supplied from
the environment before process start — never from Python afterwards.

### Definition of Done

- A turn replayed against the rebuilt bridge produces Phoenix spans containing the prompt text.
- Those spans expose `llm.input_messages.*` / `llm.output_messages.*`, the attributes Phoenix's
  message panes render (not merely the raw `gen_ai.*` attributes).
- An `execute_tool run_local_command` span carries both the command and its output.
- Running without content capture logs a warning instead of silently exporting empty spans.

### Resolution via WBS

1. Set `ENABLE_SENSITIVE_DATA=true` (overridable) in the compose bridge service, documenting why
   it must be disabled for any non-local collector. Warn from `configure_telemetry()` when
   content capture is off. Commit: `fix(bridge): export agent message content to Phoenix`.

### Specific change surface

- `opecode-sprints/remote-maf-handoff-agents/docker-compose.yml` — `ENABLE_SENSITIVE_DATA`
  env var on the `bridge` service.
- `remote-maf-handoff-agents/app/telemetry.py` — module docstring documents the two
  switches; `configure_telemetry()` reads `OBSERVABILITY_SETTINGS.SENSITIVE_DATA_ENABLED` after
  installing the provider and warns when it is off.
- `opecode-sprints/remote-maf-handoff-agents/VERIFY.md` — "Phoenix shows traces but empty
  messages" troubleshooting section.

### Verified

Queried Phoenix's GraphQL API directly after rebuilding the container and replaying a turn:

- 4 spans contain the probe prompt text (previously 0).
- The `chat gpt-4o-mini` LLM span exposes `llm.input_messages.0.message.content`,
  `llm.output_messages.0.message.tool_calls`, and `input.value`/`output.value`.
- `execute_tool run_local_command` carries `input.value` = `{"command": "cat marker.txt"}` and
  `output.value` = the command's real output.
- 7 bridge tests still pass.

### Security note

Content capture exports raw conversation text, including anything an agent reads out of the
local workspace via `run_local_command`. WS12 flipped the default to off; opt in per-run with
`ENABLE_SENSITIVE_DATA=true docker compose ... up -d bridge`, and never against a shared or
hosted collector.


---

## WS12 — workflow-session-semantics

### Goal

A remote session behaves the way the backend orchestration actually behaves: switching to a
different participant keeps the conversation, the manifest states each orchestrator's context
and addressing semantics, Phoenix names the agents that handled each turn, and no conversation
content leaves the process unless someone opts in.

### Problem

Four observable symptoms, reported by the user after WS11:

1. Picking a different participant lost the entire conversation. The agent that answered had no
   memory of anything said before the switch.
2. A picked participant frequently did not become the responder — asked to hand off to
   `refunds`, `billing` kept answering.
3. Phoenix showed only `workflow.run` / `workflow.build` chain spans. Answering "which agent was
   engaged?" meant drilling into the executor tree.
4. Prompt and completion content was exported to the collector by default.

### Preliminary investigation and root cause

**Symptom 1.** `packages/core/src/session/runner/remote.ts` keyed its per-Session connection map
on the full WebSocket URL, and `start_agent` is a query parameter on that URL. So a participant
switch produced a different URL, which closed the socket and opened a new one. That is fatal
because the MAF workflow instance is created per-connection server-side
(`app/server.py` `session(...)`), and MAF's handoff pattern keeps the whole conversation inside
the workflow: every participant holds a synchronized replica. One socket = one conversation.

**Symptom 2.** `_HANDOFF_COMPLIANCE_INSTRUCTION` in `app/orchestrator.py` told agents to comply
with an explicit handoff request *"unless doing so would be clearly irrelevant to their
request"*. Agents used that escape hatch. `HandoffBuilder` defaults to a mesh topology
(`_handoff.py:714-760` — "If no handoffs are specified, all agents can hand off to all others"),
so the routing was available; the model simply declined to use it.

**Symptom 3.** The bridge owned no spans of its own. Everything in Phoenix came from MAF's own
instrumentation, which names spans after workflow executors rather than after conversational
agents.

**Symptom 4.** `ENABLE_SENSITIVE_DATA=true` was set in `docker-compose.yml` by WS11 to prove the
wiring worked, and was never flipped back.

**Pattern semantics investigation.** The user's stated model — handoff means scoped narrow
passdown, group chat means complete context — turns out to be inverted for handoff. Read from
the orchestration builders in `agent-framework`:

| Pattern | Context scope | Multi-turn | Addressable |
|---|---|---|---|
| Handoff | **shared** — continuous broadcast; each participant keeps a synchronized replica | yes — `request_info` continues the same run | yes (`.with_start_agent()`) |
| Group chat | shared — the orchestrator's `_full_conversation` is authoritative | no — single-shot per run | no |
| Magentic | shared for participants, richer for the manager | no — `_terminated=True` after the final answer | no |
| Sequential | shared by default (`prior.full_conversation` forwarded); **scoped** with `chain_only_agent_responses=True` | no | no |
| Concurrent | **isolated** — each agent sees only the original user input | no | no |

Two consequences: **concurrent is the narrow pass-down, not handoff**; and sequential's scope is
a build-time property, so it cannot be derived from the pattern name and needs a per-orchestrator
override.

### Definition of Done

- `GET /agents/manifest` reports `pattern`, `context_scope`, `multi_turn` and `addressable` per
  orchestrator.
- Switching participant mid-conversation keeps the conversation: the newly-picked agent can
  answer a question that depends on something said before the switch.
- The newly-picked agent, not the previous one, is the responder.
- Switching to a different *orchestrator* still opens a fresh workflow.
- A Phoenix trace names the handoff chain for each turn and carries the orchestrator, its
  pattern, the responding agent and the OpenCode session id.
- With no opt-in, no span contains conversation content.
- The `/agent` picker offers no participant entries for a non-addressable pattern.

### Resolution via WBS

1. `fix(bridge): make Phoenix content capture opt-in` — default `ENABLE_SENSITIVE_DATA=false`,
   document the opt-in and the "never against a shared collector" rule.
2. `feat(bridge): advertise per-pattern session semantics in the manifest` — `PATTERN_SEMANTICS`
   in `app/orchestrator.py`, four capability fields on `OrchestratorManifestEntry`, and a 4400
   refusal when `start_agent` is given for a non-addressable pattern.
3. `feat(bridge): name the engaged agents on a per-turn Phoenix span` — bridge-owned span per
   turn, renamed to the handoff chain once known; handoff edges count towards the chain, not
   just agents that produced output.
4. `feat(core): mirror pattern capability fields into the remote protocol` — optional fields so
   an older bridge still parses; regenerate the JS SDK.
5. `fix(core): preserve the conversation when switching remote participants` — re-key the
   connection map on orchestrator URL, add `redirectTo`/`sendUserTurn` to `RemoteConnection`,
   thread the session id into the connect URL.
6. `fix(bridge): make a picked participant actually become the responder` — remove the
   compliance escape hatch.
7. `feat(tui): hide participant entries for non-addressable patterns`.

### Specific change surface

- `opecode-sprints/remote-maf-handoff-agents/docker-compose.yml` — `ENABLE_SENSITIVE_DATA`
  default and opt-in documentation.
- `remote-maf-handoff-agents/app/protocol.py` — `OrchestratorManifestEntry` capability
  fields; consumed by `manifest_entry()` below.
- `remote-maf-handoff-agents/app/orchestrator.py` — `PATTERN_SEMANTICS`; `OrchestratorSpec`
  `pattern` / `context_scope_override`; `manifest_entry()` emits the fields;
  `_HANDOFF_COMPLIANCE_INSTRUCTION` made unconditional.
- `remote-maf-handoff-agents/app/server.py` — `_tracer`; `session_id` query param; 4400
  refusal for non-addressable patterns; per-turn span; `_consume_workflow_events(..., engaged)`.
- `remote-maf-handoff-agents/tests/test_server.py` — 9 tests.
- `packages/core/src/session/execution/remote-protocol.ts` — capability fields mirrored.
- `packages/sdk/js/src/v2/gen/types.gen.ts` — regenerated, so the TUI sees `addressable`.
- `packages/core/src/session/runner/remote.ts` — `REDIRECT_INSTRUCTION`; `pendingRedirect`,
  `redirectTo()`, `sendUserTurn()` on `RemoteConnection`; `Bound` connection map keyed on
  orchestrator URL; `toWebSocketURL` takes `sessionID`.
- `packages/opencode/src/session/llm/remote-stream.ts` — routes its user turn through
  `sendUserTurn` so the V1 prompt path picks up redirects too.
- `packages/tui/src/component/dialog-agent.tsx` — participant entries gated on `addressable`.
- `packages/core/test/session-runner-remote-switch.test.ts` — new; drives the real
  `openConnection` against a live WebSocket stub.

### Verified

Against a rebuilt container and a live Phoenix:

- Manifest reports `pattern: handoff`, `context_scope: shared`, `multi_turn: true`,
  `addressable: true`.
- Over one socket: turn 1 mentions invoice `INV-4471` to `triage`; a participant switch to
  `refunds` is folded into turn 2; `refunds` answers turn 3 and still knows the invoice number.
- Before the compliance fix the same probe left `billing` answering; after it, `refunds` does.
- Phoenix span `turn support/triage→billing→refunds→billing` with
  `maf.agents.engaged`, `maf.agent.responding`, `maf.orchestrator.pattern` and a `session.id`
  Phoenix groups on.
- With the default settings, 0 spans contain the probe text.
- 9 bridge tests, 2 new core tests, 6 opencode remote tests pass; core/opencode/tui typecheck.

### Deviation

The participant redirect is advisory. MAF decides handoffs through the active agent's own tool
call, so the bridge cannot force a specific agent to become the responder — it can only make the
request unambiguous, which the strengthened instruction does. The same limitation already
applies to `steer_to_agent` (WS9).

---

## WS13 — release a remote binding

See `investigation-remote-session-lifecycle.md` for the full investigation behind this
workstream, including the assessment of the "one TUI per remote agent" proposal.

### Goal

A user who picked a remote agent can pick a native agent again and get the local runner back.

### Problem

> Once I'm logged in to the remote agents, I can't switch back to the native build / plan agent.

Selecting `build` changed the status-bar label while the session kept routing to the bridge, and
generic workspace-resolution paths surfaced `Workspace not found: remote:demo-bridge:support` and
a *"Workspace Unavailable — restore this session into a new workspace"* prompt.

### Preliminary investigation and root cause

The binding is one-way. Three facts combine:

1. `handlers/remote-agent.ts:71-81` — `select` writes the `remote:` sentinel onto
   `session.workspaceID`, and `session.ts:814-821` overwrites without retaining the old value.
2. `groups/remote-agent.ts:76-101` — the API group exposed only `list`, `select` and `steer`.
   **There was no unbind operation.**
3. `dialog-agent.tsx:103-107` — picking a local agent only set the agent name and returned.

Routing follows the session's Location (`prompt.ts:1190` parses `session.workspaceID`), not the
agent label, so the session stayed remote. The sentinel is not a real registered workspace, which
is what the workspace-resolution prompts were reacting to.

The hypothesis that a terminal is tied to a live remote session is not what the code does: the
binding is per-session (`remote.ts:213` keys connections by `SessionSchema.ID`), so a native and a
remote session already coexist in one TUI.

### Definition of Done

- `POST /experimental/remote-agent/release` returns the session to the Location it had before
  binding and closes the remote connection.
- Picking a native agent from `/agent` on a remote-bound session restores the local runner
  without a workspace-recovery prompt.
- Releasing an unbound session is a no-op, not an error.

### Resolution via WBS

1. `feat(server): add a release endpoint for remote agent bindings` — `ReleasePayload` /
   `ReleaseResponse`, the endpoint, and a handler that closes the socket and restores
   `InstanceState.workspaceID` (what `Session.create` assigns at `session.ts:677/687`, making the
   round trip symmetric).
2. `feat(tui): release the remote binding when a native agent is picked`.

### Specific change surface

- `packages/opencode/src/server/routes/instance/httpapi/groups/remote-agent.ts` —
  `ReleasePayload`, `ReleaseResponse`, `RemoteAgentPaths.release`, the endpoint.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/remote-agent.ts` — `release`,
  registered via `.handle("release", release)`.
- `packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts` — regenerated so the TUI can call it.
- `packages/tui/src/component/dialog-agent.tsx` — `remoteBinding()` memo; the local branch of
  `onSelect` calls `release`.
- `packages/opencode/test/server/httpapi-remote-agent.test.ts` — release round-trip test.

### Verified

Against the live bridge through a real `opencode serve`:

- A fresh session has `workspaceID: null`; `select` sets `remote:demo-bridge:support:refunds`;
  `release` returns it to exactly `null` — so no workspace-recovery prompt can fire.
- A real remote turn ran (`providerID: remote-agent`), then `release` reported `released: true`.
- Re-selecting and asking for the earlier invoice number returned *"I can't recall previous
  messages"*, proving the socket was closed and the MAF workflow destroyed. (Contrast WS12, where
  the same probe across a participant switch recalled the number.)
- A second `release` on the same session returned `released: false`.
- 4 remote-agent HttpApi tests pass; opencode and tui typecheck.

### Deviation

Release restores `InstanceState.workspaceID` rather than the exact prior workspace, because
`select` does not retain it. These coincide for the single-workspace case this PoC targets. A
session bound to a remote agent from a non-default workspace would return to the instance
workspace instead.

### Not done: detach and resume

Requirement (C) from the investigation — close the client, log back into the remote session — is
**not** delivered here and is not achievable by opening more TUIs. It needs bridge-side
checkpointing keyed by `session_id`. Tracked as WS14.

---

## WS14 — durable remote conversations (`durable-remote-sessions`)

Delivers requirement (C) from `investigation-remote-session-lifecycle.md`: close the client, come
back later, and continue the same conversation with the same agent.

### Problem

A remote conversation lived only in the bridge process, in the `Workflow` object held by the open
WebSocket. Closing the socket destroyed it. Since every TUI spawns its own server worker, quitting
the TUI closed every bridge socket — so a remote session could never be rejoined, only restarted.

### Resolution

MAF workflows already checkpoint at exactly the moment we care about: the runner writes a
checkpoint when the workflow goes idle awaiting user input, and a restored checkpoint keeps the
same pending request id, so a restore can be answered as if the original request were still open.

Checkpoints are selected only by workflow *name*, so `app/checkpoints.py` names each workflow
`<orchestrator_id>::<session_id>`. An experiment confirmed a workflow's name does not feed its
`graph_signature_hash`, so per-session naming does not break the topology validation a restore
performs.

On connect the bridge looks for the newest checkpoint for that name that is parked awaiting user
input. If it finds one it emits a `session_resumed` frame and delivers the turn as the response to
the request the workflow was already waiting on; otherwise the session starts fresh.

### Verified

- Same `session_id`, socket closed between turns: the agent recalled `INV-8823`. Before WS14 the
  same probe returned *"I don't have access to previous conversations."*
- Repeated across a `docker restart`: still recalled, from the `bridge-checkpoints` volume.
- An unrecognised `session_id` sent no `session_resumed` frame and had no memory — sessions do not
  leak into each other.
- End-to-end through `opencode serve`: `select` → state `INV-9911` → `release` → `select` → the
  agent recalled it. This is the exact probe that returned *"I can't recall previous messages"* in
  WS13.
- 9 bridge tests pass; core and tui typecheck.

### Deviation

Checkpoint payloads are pickled and gated by an allowlist. The framework auto-allows the
`agent_framework.` module prefix, but the orchestrations package is `agent_framework_orchestrations.`
and falls outside it, so `HandoffAgentUserRequest` (and the `GenericAlias` in its annotation) must
be named explicitly or every checkpoint written is unreadable on load. The list was derived by
decoding real checkpoints rather than guessed; it widens what unpickling may instantiate, so it is
kept minimal.

No `resumable` manifest field was added as originally designed: it would have duplicated
`multi_turn`, since only multi-turn patterns leave a conversation parked awaiting input.

## WS15 — rejoinable session UX (`durable-remote-sessions`)

### Problem

WS14 made a remote conversation survivable, but nothing surfaced it: picking an agent always
created a brand-new session, and there was no way to see which conversations an agent already held.

### Resolution

- A sidebar panel lists the other sessions bound to the same remote agent, current one marked,
  each selectable. This is the "tab to the right" for picking a session.
- Picking a remote agent with no session open now offers that agent's existing conversations to
  rejoin, with "New session" first, instead of silently starting over.

Both filter on the `remote:<server>:<orchestrator>` sentinel already stored in `session.workspaceID`,
which OpenCode persists — so no new storage was needed for the OpenCode half. Participant is
deliberately ignored when grouping: addressing a different agent inside one orchestrator is still
the same conversation.

### Known limitation

Explicitly switching back to a native agent calls `release`, which clears `workspaceID` — so that
session stops being listed under the agent. The conversation is not lost: navigating to the session
and selecting the agent again still resumes it from its checkpoint (verified above). Only its
listing is affected. The detach/rejoin path the requirement asks for does not call `release` and is
unaffected.

## WS16 — private (solo) conversations (`solo-remote-sessions`)

### Problem

Every remote conversation went through the orchestrator's workflow, where a handoff network
broadcasts the full conversation to every participant. There was no way to say something to one
agent without the others seeing it, and no way to consult a single agent without the workflow
deciding to hand the conversation elsewhere.

### Resolution

A `solo` connection skips the workflow entirely: one named participant, no handoff edges, and a
transcript of its own. The sentinel gains a trailing `:solo` segment
(`remote:<server>:<orchestrator>:<participant>:solo`), `select` accepts a `solo` flag, and the
agent picker lists a private entry per agent alongside the network entries.

Persistence differs by necessity. There is no workflow, so there is no workflow checkpoint;
`app/sessions.py` stores the framework's own `AgentSession` instead, keyed per agent and session,
so a private conversation rejoins exactly like a shared one.

Connection reuse had to change with it. In the shared conversation, switching participants
redirects the live socket, because every participant sees the same conversation. Solo is the
opposite: each agent holds its own, so switching participants reconnects.

### Verified

- A private turn to `billing` engaged only `billing` and produced no handoff frames, where the
  same orchestrator's shared conversation hands off to billing via triage.
- Reconnecting a private session recalled `INV-5150`; so did a reconnect after a container restart.
- An unused session id neither resumed nor recalled anything.
- The shared conversation under the *same* session id did not know `INV-5150`, and a second private
  agent (`refunds`) did not know an invoice given privately to `billing`.
- End-to-end through `opencode serve`: select private `billing` → state `INV-3030` → release →
  reselect → recalled. `solo` without a participant is rejected with HTTP 400.
- 13 bridge tests pass (9 before); core, opencode and tui typecheck; remote-agent and
  remote-stream suites pass.

### Deviation

**A private conversation's content is held by the model provider, not by this container.** With the
OpenAI client the transcript lives service-side and `AgentSession.to_dict()` yields only a
`service_session_id` pointer — around 140 bytes, with an empty `state`, confirmed by inspecting a
real serialized session. Rejoining works, but unlike a handoff conversation (whose full content is
checkpointed onto our own volume) deleting the local file does not delete the conversation, and
retention is the provider's. A provider that keeps history client-side would populate `state`
instead, which `app/sessions.py` stores just as well.

This matters for the same reason telemetry content capture defaults off: "private" here means
private *from the other agents*, not private from the model provider.
