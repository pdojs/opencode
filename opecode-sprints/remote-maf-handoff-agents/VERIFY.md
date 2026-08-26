# VERIFY.md — manual end-to-end verification (WS5)

This is the Layer 4 (Docker + real LLM) manual check referenced by `design-proposal.md`'s
Testing Strategy and `test-requirements.md`'s demo scripts. It exercises the full stack —
a real local OpenCode build, a real Docker container, a real workspace directory, and a real
OpenAI-backed sample MAF handoff group — none of it faked or mocked.

## 0. Prerequisites

- Docker (with a running daemon) and Docker Compose v2 (`docker compose`, not `docker-compose`).
- An `OPENAI_API_KEY` with access to a chat-completions-capable model (the sample agents in
  `test/remote-maf-handoff-agents/app/orchestrator.py` are `OpenAIChatClient()`-backed —
  independent of whatever LLM endpoint the OpenCode harness itself uses).
- A local OpenCode build from `feature/remote-maf-handoff-agents` (or later) — WS1-WS4 must all
  be present.
- A scratch git-initialized directory to use as the "local workspace" a remote tool call can
  act on (e.g. `mkdir -p /tmp/maf-demo-workspace && cd /tmp/maf-demo-workspace && git init`).
  This is required for Demo 2 row 9 / WS3's remote-tool-bridge behavior — a remote agent's
  `run_local_command` tool call executes against whatever directory the bound OpenCode Session's
  Location points at, exactly like a local agent's own tool calls.

## 1. Start the dev environment

```bash
export OPENAI_API_KEY=sk-...
cd /Users/pdops/projects/opencode
docker compose -f opecode-sprints/remote-maf-handoff-agents/docker-compose.yml up --build
```

Wait for both containers to report healthy/ready, then in a second terminal:

```bash
curl -s localhost:8000/agents/manifest | jq .
```

**Pass criterion**: returns JSON with an `orchestrators` array containing at least one entry
(the sample "support" orchestrator) whose `participants` array lists ≥2 agents (e.g. `triage`,
`billing`, and ideally `refunds` for Demo 3).

Open `http://localhost:6006` in a browser — the Phoenix UI should load with no projects/traces
yet (traces appear once a turn is run in step 3+).

## 2. Configure OpenCode to see the bridge

In the workspace directory from step 0, add to OpenCode's config (per WS2's config schema,
`packages/core/src/config.ts`'s `remote_agent` field):

```json
{
  "remote_agent": {
    "servers": {
      "demo-bridge": { "url": "http://localhost:8000" }
    }
  }
}
```

Start OpenCode's TUI in that workspace directory.

## 3. Run Demo 1 — select, converse, observe

Follow `test-requirements.md`'s Demo 1 table exactly (rows 1-6):

1. `/agent` → picker opens with **Native** / **Workspace** / **Remote** sections.
2. Select the `demo-bridge` orchestrator entry under **Remote**.
3. Send "I need help with a billing question."
4. Confirm the reply streams incrementally (not one instantaneous block).
5. Confirm a handoff indicator (inline `↪ handoff: triage → billing` text — see the WS4
   deviation note below) appears when the sample agents hand off.
6. Confirm a coherent final reply, then open `http://localhost:6006` and confirm a trace
   appears for this run with spans for the workflow execution and the `triage → billing`
   handoff.

**Pass criterion**: all 6 rows hold, matching `test-requirements.md` Demo 1 exactly.

## 4. Run Demo 2 — steering and stopping

Continue with `test-requirements.md`'s Demo 2 rows 7-10:

7. Send a request likely to produce a long streamed reply.
8. While streaming, send a follow-up message — confirm it's accepted by the same input
   component used for local sessions (no "remote busy" state) and the eventual reply reflects
   the follow-up.
9. Start a new turn, interrupt it mid-stream (Esc / stop keybinding) — confirm streaming halts
   and the container logs a closed/cancelled connection for that turn.
10. Send a new message after the interrupt — confirm a fresh turn starts normally.

**Pass criterion**: rows 7-10 hold, in addition to Demo 1's rows still holding.

## 5. Run Demo 3 — targeting a specific participant

**Status: rows 11 and 14 (which depend on a `/participants` steer/stop picker) cannot be run
yet.** WS4's `wbs.md`/`design-proposal.md` explicitly recorded this as deferred: the picker
dialog and `/participants` command were not built in the WS4 pass, in favor of shipping the
core select→stream→observe flow first. What **can** be verified today, using WS2's
already-implemented `steerToAgent` directly (e.g. via a temporary debug script or a follow-up
WS4 patch that wires the picker before running this section):

- Row 12 (steer to a participant mid-turn, observe the agent complying) and row 13 (stop the
  active participant, equivalent to the existing interrupt) are exercisable once a
  `steerToAgent` call site exists in the TUI. Until then, this section is **blocked** on the
  `/participants` picker follow-up noted in `wbs.md`'s WS4 status entry.

**Action item for whoever picks this up next**: implement the deferred `/participants` dialog
(WBS step 6 from the original WS4 plan in `design-proposal.md`), then complete rows 11-14 here.
Do not mark Demo 3 "passed" until that dialog exists and rows 11-14 are actually run against a
real container — this doc intentionally does not claim otherwise.

## 6. Tear down

```bash
docker compose -f opecode-sprints/remote-maf-handoff-agents/docker-compose.yml down
```

## Verification status of this doc itself

`opecode-sprints/remote-maf-handoff-agents/docker-compose.yml` was validated with
`docker-compose -f ... config` (confirms YAML/schema correctness, resolves the `bridge` build
context and `phoenix` image references, confirms env var interpolation). **`docker-compose up
--build` (note: this environment provides the standalone `docker-compose` v1 CLI, not the
`docker compose` v2 plugin) has since been run end-to-end against a live daemon and a real
OpenAI key**, which surfaced and led to fixing 4 real runtime bugs not caught by any prior
code-only review (see `wbs.md`'s "Dogfooding Demo 1" entry for full detail: 2 bridge-container
bugs fixed in PR #10, 2 more — including a `WorkspaceV2.ID` schema bug that made
`/experimental/remote-agent/select` completely non-functional — fixed in PR #11). Demo 1 rows
1-6 were confirmed via a scripted API walkthrough (session create -> remote-agent select ->
prompt -> observe a real `triage -> billing` handoff relayed into the session's messages);
Demo 2/3's TUI-specific rows (actual `/agent` keystrokes, visual picker, steer-while-streaming)
still require a human driving the real TUI — the underlying API/runtime path they depend on is
now confirmed unblocked.

## Known gaps / follow-ups surfaced while writing this doc

- **`/participants` steer/stop picker** (blocks Demo 3 rows 11-14, see §5) — deferred from WS4,
  tracked in `wbs.md`.
- **No automated CI runs this doc** — by design (Layer 4 is manual-only per the Testing
  Strategy), but that also means regressions here are only caught by a human re-running these
  steps; re-run this doc after any change touching WS1-WS4 before relying on a demo.
