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
`packages/core/src/config/remote-agent.ts`'s `remote_agent.servers` field — an **array** of
`{id, url}` objects, not a keyed/dict object):

```json
{
  "remote_agent": {
    "servers": [
      { "id": "demo-bridge", "url": "http://localhost:8000" }
    ]
  }
}
```

Start OpenCode's TUI **with the workspace directory passed as the `[project]` positional
argument**, not just via `cd`:

```bash
bun run --cwd /path/to/opencode/packages/opencode --conditions=browser src/index.ts /path/to/workspace
```

**Gotcha**: `bun run --cwd <opencode-repo-path>` is required so bun can resolve
`node_modules`/`react/jsx-dev-runtime` etc from the opencode package — but it also silently
overrides `process.cwd()` for the *entire* process, including OpenCode's own project-directory
resolution (`resolveThreadDirectory` in `packages/opencode/src/cli/cmd/tui.ts`, which only reads
`process.cwd()` when no `[project]` arg is given — it does **not** fall back to reading
`$PWD`). A plain `cd /path/to/workspace && bun run --cwd .../packages/opencode ...` will boot
the TUI against the *opencode repo* directory instead of your workspace, silently ignoring your
workspace's `opencode.json` (including its `remote_agent.servers` entries) — the `/agent` picker
will then only show "Native"/"Workspace" agents with no "Remote" section, with no error shown.
Always pass the workspace path explicitly as the trailing `[project]` argument instead of
relying on `cd`.

## 3. Run Demo 1 — select, converse, observe

Remote turns render through the **V1** message path as of PR #16 (`wbs.md` WS8): the TUI's
timeline only understands V1 `message.updated` / `message.part.updated`, so `SessionLLM.stream`
is substituted for remote-bound Sessions instead of routing prompts to the V2 endpoint. Nothing
changes in how you drive the demo — but if you are debugging with `curl`, use
`POST /session/{id}/message`, not `/api/session/{id}/prompt`, to see what the TUI sees.

Follow `test-requirements.md`'s Demo 1 table exactly (rows 1-6):

1. `/agent` → picker opens with **Native** / **Workspace** sections plus a
   **Remote · Support Triage** section. As of WS10 that section lists the orchestrator
   (`Support Triage`) *and* every agent in its network — `Triage`, `Billing`, `Refunds` —
   each with a description. Selecting a participant starts the conversation at that agent
   instead of at the network's default start agent; handoffs still apply from there.
2. Select the `Support Triage` orchestrator entry under **Remote · Support Triage**.
3. Send "I need help with a billing question."
4. Confirm the reply streams incrementally (not one instantaneous block).
5. Confirm a handoff indicator (inline `↪ handoff: triage → billing` text — see the WS4
   deviation note below) appears when the sample agents hand off.
6a. Optional local-workspace check: `echo hello-from-workspace > marker.txt` in the workspace,
   then ask "Run this in my local workspace: cat marker.txt". The remote agent's
   `run_local_command` is bridged to OpenCode's `bash` tool and runs on **your** machine under
   the normal permission prompts, so the reply should quote the file's real contents.
6b. Optional roster check (WS10): run `/agent` again and pick **Refunds**. The status bar
   bottom-left should now read `Refunds` (not `Support` or `Build`). Ask "Who am I speaking
   with?" — the reply should come from the refunds agent directly, with no triage greeting
   first. Picking a different participant on the same session reconnects the bridge, so the
   next turn starts at the newly-selected agent.
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

The `/participants` picker deferred in the original WS4 pass now exists, so rows 11-14 are
runnable:

11. With a remote-bound session, run `/participants` — the picker lists the bound
    orchestrator's participants (`triage`, `billing`, `refunds` for the sample bridge). The
    command is hidden for non-remote sessions, so it will not appear until you have selected a
    remote agent with `/agents`.
12. Send a message, then run `/participants` **while the reply is still streaming** and pick a
    different participant. Confirm a `↪ handoff: <current> → <picked>` marker appears and the
    picked agent replies — all inside the same assistant message.
13. Stop the active participant with the interrupt keybinding — same path as Demo 2 row 9.
14. Run `/participants` with no turn in flight. Confirm the "Nothing to steer" warning toast
    appears and nothing is sent.

**Why steering must be mid-turn**: the bridge answers a `steer_to_agent` frame with a whole
extra turn rather than redirecting the in-flight one, so the frame is only sent while a relay
is running to absorb that turn. Steering an idle connection used to strand those frames and
replay them as the *next* prompt's answer; it is now refused outright
(`SessionRunnerRemote.steerToAgent` returns `delivered: false`).

Steering remains advisory in the MAF sense: the orchestrator may decline. Row 12 passes when
the handoff marker and the picked agent's reply appear for a request the agent can reasonably
comply with — not on every possible prompt.

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

## Known gap: remote sentinels vs. the workspace registry

A remote binding is stored as a `remote:<serverID>:<orchestratorID>` sentinel in the session's
`workspaceID`, and PR #15 deliberately keeps that sentinel **out** of the workspace registry.
Any TUI code that resolves `workspaceID` through `project.workspace.*` therefore sees a
dangling workspace unless it checks `parseRemoteWorkspaceID` first.

This bit once already: the submit path gated on
`project.workspace.status(workspaceID) ?? "error"`, so sending the first message to a
remote-bound session opened the **"Workspace Unavailable"** dialog. Choosing *Restore → None
(use the local project)* then warped the session to `workspaceID: null`, silently discarding
the remote binding — the status bar reverted to the local agent and the next prompt ran
locally, making the remote selection appear impossible to persist. Fixed by skipping the gate
for sentinels.

If you add code that reads a session's `workspaceID`, check `parseRemoteWorkspaceID`
(`packages/tui/src/util/remote-agent.ts`) before treating a miss as a broken workspace. The
remaining known un-guarded caller is `dialog-session-list.tsx`'s `recover()`, which only runs
when a session *delete* fails.

## Known gap: Phoenix shows traces but empty messages

If the Phoenix trace tree renders (spans, durations, token counts) but every message pane is
blank, the cause is `ENABLE_SENSITIVE_DATA`, not the exporter.

Agent Framework splits telemetry into two independent switches:

| Switch | Default | Governs |
| --- | --- | --- |
| `PHOENIX_COLLECTOR_ENDPOINT` (read by `app/telemetry.py`) | unset | whether spans are exported at all |
| `ENABLE_SENSITIVE_DATA` (read by `agent_framework` itself) | **false** | whether those spans carry message content |

With only the first set you get the shape of the run but none of its substance:
`ObservabilitySettings.enable_sensitive_data` defaults to `False`
(`agent_framework/observability.py`), and every prompt, completion, tool argument and tool
result is gated behind it. `docker-compose.yml` now sets `ENABLE_SENSITIVE_DATA=true` by
default; `configure_telemetry()` logs a warning when it is off so the failure is visible
instead of silent.

The setting is read once into a module-level singleton at `agent_framework` import time, so it
**must** be in the environment before the process starts — setting it from Python afterwards
has no effect.

Turn it off (`ENABLE_SENSITIVE_DATA=false`) if you ever point `PHOENIX_COLLECTOR_ENDPOINT` at a
shared or hosted backend: it exports raw conversation content, including anything the agent
read out of your local workspace via `run_local_command`.

Verified after enabling: the OpenInference processor translates
`gen_ai.input.messages`/`gen_ai.output.messages` into the `llm.input_messages.*` /
`llm.output_messages.*` attributes Phoenix's UI renders, and `execute_tool run_local_command`
spans carry both the command (`input.value` = `{"command": "cat marker.txt"}`) and its output.

## WS12 — per-pattern session semantics

### Manifest advertises capabilities

```bash
curl -s localhost:8000/agents/manifest | python3 -m json.tool
```

Each orchestrator carries `pattern`, `context_scope`, `multi_turn` and `addressable`. For the
sample support group: `handoff` / `shared` / `true` / `true`.

The values are not the intuitive ones. Handoff broadcasts the whole conversation to every
participant; **concurrent** is the narrow pass-down. Group chat, magentic and sequential are
single-shot, so a second user turn is a new run with no memory of the first.

### Switching participant keeps the conversation

In the TUI, with a remote orchestrator selected:

1. Say `My invoice INV-4471 was charged twice.`
2. Run `/agent` and pick a different participant (e.g. **Refunds**).
3. Ask `Which invoice number did I mention?`

The newly-picked agent answers `INV-4471`. Before WS12 this lost the conversation entirely,
because changing participant reconnected the socket and the MAF workflow behind it.

The status bar should show the picked participant, and the responder should be that participant
— not whichever agent was answering before.

### Phoenix names the agents that handled the turn

Open Phoenix at <http://localhost:6006> and look at the root spans. Each turn now has a span
named for its handoff chain, e.g.:

```
turn support/triage→billing→refunds
```

Its attributes carry `maf.orchestrator.id`, `maf.orchestrator.pattern`, `maf.agents.engaged`,
`maf.agent.responding` and `session.id`. Phoenix groups on `session.id`, so a whole conversation
can be pulled up from the OpenCode session it came from.

To assert on this without the UI:

```bash
curl -s localhost:6006/graphql -H 'content-type: application/json' \
  -d '{"query":"{ projects(first:1){edges{node{ spans(first:50, sort:{col:startTime,dir:desc}){edges{node{ name attributes }}} }}} }"}'
```

### Content capture is off by default

With a default `docker compose up`, no span contains conversation text — only metadata. To
inspect prompts and completions during local testing:

```bash
ENABLE_SENSITIVE_DATA=true docker compose -f docker-compose.yml up -d bridge
```

Never enable it against a shared or hosted collector: it exports raw conversation text,
including anything an agent read out of the local workspace via `run_local_command`.
