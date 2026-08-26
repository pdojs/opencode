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

- `maf-container-server` (WS1) — **implemented as `test/remote-maf-handoff-agents/` inside the
  `opencode` repo**, not a branch in `agent-framework`. See status note.
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
  as a standalone Python app at `test/remote-maf-handoff-agents/` inside the `opencode` repo
  (per explicit instruction — "create a new test folder with the agentic app source code
  there; we will eventually move this test case out of this workspace"). It depends on the
  published PyPI packages `agent-framework-core`/`agent-framework-orchestrations`/
  `agent-framework-openai`, not a local path dependency on the `agent-framework` checkout, so
  it is portable and can be extracted into its own repo later without modification.
- **WS1 status**: implemented and merged into `story/maf-container-server`
  (PR: `feature/remote-maf-handoff-agents` <- `story/maf-container-server`, 3 commits — manifest
  + chat + tool bridge, OTel wiring, Dockerfile/README). 5/5 Layer 1 contract tests passing
  (`python -m pytest tests/ -q` in `test/remote-maf-handoff-agents/`). `docker build` itself was
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
