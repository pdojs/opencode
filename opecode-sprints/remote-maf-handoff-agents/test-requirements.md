# Test Requirements: Remote MAF Handoff Agents

This document defines the demo scripts used to validate the Definition of Done in
`requirements.md` end-to-end, on top of the automated Testing Strategy (4 layers) in
`design-proposal.md`. The demos are additive: Demo 2 = Demo 1 + new steps, Demo 3 = Demo 2 +
new steps. Each step has a concrete, observable expected outcome — no step is "it should work."

## Preconditions (all demos)

- `docker compose up` (from WS5's `docker-compose.yml`) is running: the MAF handoff-bridge
  container (≥2 sample participant agents wired via `_handoff.py`, e.g. `triage` and
  `billing`) and a local Phoenix instance.
- `curl localhost:<port>/agents/manifest` returns a manifest listing the orchestrator and its
  `participants` array (at least 2 entries).
- OpenCode is configured with `remoteAgent.servers` pointing at the container (WS2 config
  surface), and is running against a real local workspace directory (e.g. a scratch git repo)
  so remote tool calls have somewhere real to land.
- Phoenix UI is reachable in a browser at its default local URL.

---

## Demo 1 — Select, converse, observe (WS1 + WS2 + WS4 core path)

**Goal**: prove basic selection, streaming, and passive telemetry — no steering/stopping yet.

| # | Action | Expected outcome |
|---|--------|-------------------|
| 1 | In OpenCode's prompt, type `/agent` and press Enter. | The picker dialog opens showing three headed sections in order: **Native**, **Workspace**, **Remote**. The **Remote** section contains one entry per container in `remoteAgent.servers`, named/described per the container's manifest response. |
| 2 | Scroll down into the **Remote** section and select the orchestrator entry. | The dialog closes. No error is shown. The session's bound Location is now the remote orchestrator (verifiable via any existing session-status surface, or simply by proceeding to step 3). |
| 3 | Type a simple request (e.g. "I need help with a billing question") and submit. | The reply begins streaming incrementally into the session view (visible token/segment-by-segment growth, not a single instantaneous block) — proving the `assistant_delta` → TUI rendering path (WS2/WS4) works, not just a final `turn_complete` dump. |
| 4 | Continue watching the reply if the scripted sample agents are configured to hand off (e.g. `triage` → `billing` on a billing question). | A status line/badge updates to show the newly active sub-agent's name (e.g. "billing is responding"), sourced from a relayed `handoff` frame → `session.remote-handoff` event (WS2 DoD). |
| 5 | Wait for the turn to finish. | The session view shows a complete, coherent reply; no dangling "typing" indicator remains. |
| 6 | Open the Phoenix dashboard in a browser. | A trace for this run appears, showing spans for the workflow execution and the handoff between `triage` and `billing`, independently of anything in OpenCode's UI (WS1 DoD: Phoenix is passive telemetry only). |

**Demo 1 passes** if all 6 rows hold without manual server restarts or code changes mid-demo.

---

## Demo 2 — Demo 1 + steering and stopping (WS2 steer/queue + interrupt)

Builds directly on Demo 1's steps 1-6. Continue from step 6, or start a fresh turn.

| # | Action | Expected outcome |
|---|--------|-------------------|
| 7 | Submit a new request that will trigger a longer, multi-sentence streamed reply (to give a window to steer mid-turn). | Streaming begins as in Demo 1 step 3. |
| 8 | While the reply is still streaming, type a follow-up message (e.g. "actually, also check my account balance") and submit it. | The follow-up is accepted by the same input component used for local sessions — no "remote busy" blocking state, no separate UI. The message is either steered into the current turn or queued and promoted at the next safe boundary, exactly as local `SessionV2.prompt` steer/queue semantics already work (WS4 DoD). The eventual reply visibly reflects the follow-up's content. |
| 9 | Start a new turn with a request that will take some time (e.g. one that triggers a tool call, if WS3 is present, or simply a long reply). While it is in progress, invoke the existing interrupt command (e.g. Esc / stop keybinding). | The remote turn stops: the streaming text halts, and this is independently observable as the WS chat/tool-bridge channel closing or the container logging a received cancellation (checked via container logs during the demo). No local error/crash occurs. |
| 10 | Submit a new message after the interrupt. | A fresh turn starts normally — the interrupted session is not left in a stuck/unusable state. |

**Demo 2 passes** if Demo 1's 6 rows still hold, plus rows 7-10.

---

## Demo 3 — Demo 2 + targeting any specific participant (WS1/WS2/WS4 `steer_to_agent`)

Builds directly on Demo 2. **Explicit constraint restated for this demo**: MAF's handoff
routing is entirely decided by whichever agent is currently active choosing to call its own
`handoff_to_<target_id>` tool (`_handoff.py:124-127,335-346,487-`). There is no
`HandoffBuilder`/`Workflow` API to force a hard switch. Steering to a specific participant is
therefore an **advisory nudge**, not a guaranteed override, and the demo script below verifies
it as such — the pass criterion is "the targeted agent becomes active," not "the system
proves it cannot be otherwise."

| # | Action | Expected outcome |
|---|--------|-------------------|
| 11 | While bound to the remote orchestrator (from Demo 1 step 2), open the participant picker via `/participants`. | A dialog lists every participant from the orchestrator's manifest (e.g. `triage`, `billing`, plus at least one more sample agent for this demo, e.g. `refunds`), each with "Steer here" and "Stop" actions. The dialog copy visibly labels this as best-effort (per requirements.md Decision #7). |
| 12 | Submit a request that would normally keep `triage` active (e.g. an ambiguous message not clearly billing-related), then immediately select `refunds` → "Steer here" from the participant picker before the turn completes. | A `steer_to_agent` frame is sent (observable via container logs). The container injects the advisory instruction into the currently active agent's next input. Given the sample agents' prompts are written to comply with explicit user handoff requests (per design-proposal.md WS1 DoD note), the status badge updates to show `refunds` becoming active, and the reply content reflects `refunds`' perspective. |
| 13 | Submit a new request, and while it is in progress, use the participant picker's "Stop" action on the currently active participant. | This is equivalent to the existing session interrupt from Demo 2 step 9 (only one participant is ever active at a time) — the turn halts, observable the same way. No participant-specific interrupt protocol is needed or implied. |
| 14 | (Negative case, to make the "advisory" framing concrete) Attempt to steer to a participant while sending a message the active agent's own prompt is *not* configured to comply with (e.g. steer to `billing` while asking a question with no billing relevance and using a stripped-down sample agent prompt that ignores the nudge for this one case). | The active agent does **not** hand off (it responds normally instead), the status badge does not change, and this is treated as an accepted, documented outcome of the demo — not a bug — since `steer_to_agent` is explicitly best-effort. |

**Demo 3 passes** if Demo 2's rows still hold, plus rows 11-14, with row 14 explicitly
demonstrating (not hiding) the non-guaranteed nature of participant targeting.

---

## Relationship to automated tests

These demos are the manual Layer 4 (Docker + real LLM) check from design-proposal.md's Testing
Strategy. Rows 1-2, 7-10 correspond to WS2/WS4 Layer 2/3 automated coverage
(`session-runner-remote.test.ts`, dialog-agent picker-logic tests) run against the fake WS
server instead of a real container. Rows 11-14's `steer_to_agent` behavior corresponds to WS1's
`tests/test_server.py` three-fake-agent fixture (Layer 1) and WS2's `steerToAgent` frame-send
assertion (Layer 2) — those automated tests prove the frame is sent/received correctly; only
this manual demo proves a real LLM-backed sample agent actually complies (or, in row 14,
visibly does not).
