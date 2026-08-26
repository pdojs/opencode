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
- **Next**: WS3 (`remote-tool-bridge`) — replace WS2's tool-call stub with real local execution
  through the existing `ToolRegistry`/permission path.
