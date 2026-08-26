# Design — durable, rejoinable remote agent sessions

Answers: *"When I pick an agent and start a session, I'd like the session to be persisted. When I
reselect the agent, I should be able to pick the session I was having with them [...] This will
allow me to detach and rejoin whenever."*

Supersedes the WS14 placeholder in `investigation-remote-session-lifecycle.md`.

---

## Where we are today

| Layer | State |
|---|---|
| OpenCode session record | **Already durable.** Rows in SQLite; `workspaceID` holds the `remote:` sentinel, so the agent a session belongs to is already persisted and queryable (`session.ts:964-965` filters by `workspace_id`). |
| OpenCode transcript | **Already durable.** Messages persist and replay independently of any remote connection. |
| MAF conversation | **Ephemeral.** The `Workflow` is constructed per WebSocket in `app/server.py:57` and discarded on close. `session_id` is accepted but used only as a telemetry attribute (`app/server.py:66`, `:160`). |

So two of three layers already do what the user wants. **The only thing that does not survive is the
MAF-side conversation**, and a UI to pick among the sessions that already exist.

## What MAF supports (verified)

Investigated against `/Users/pdops/projects/agent-framework`; every claim below has a citation, and
the one genuinely load-bearing unknown was settled by experiment.

- `HandoffBuilder.with_checkpointing(storage)` — `_handoff.py:850`. Identical to passing
  `checkpoint_storage=` to the constructor (`_handoff.py:647`); `build()` forwards it to
  `WorkflowBuilder` (`_handoff.py:987-994`).
- `FileCheckpointStorage(storage_path)` — `_checkpoint.py:245,266-271`. One JSON file per
  checkpoint, atomic write (`:305-317`).
- **A checkpoint is written at the exact idle-awaiting-user moment.** Every superstep ends with
  `create_checkpoint_if_enabled()` (`_runner.py:165-166`); the superstep that emits `request_info`
  completes and is checkpointed before the loop breaks (`_runner.py:169-170`). Confirmed by the
  docstring at `_checkpoint.py:64-67`.
- **The pending request survives and keeps its id.** `WorkflowCheckpoint.pending_request_info_events`
  (`_checkpoint.py:90`) is restored verbatim by `apply_checkpoint`
  (`_runner_context.py:511-513`), which also re-emits the event (`:514`).
- **Restore into a brand-new `Workflow` in a fresh process is the intended usage** —
  `_runner.py:278-338`; sample comment at
  `samples/03-workflows/checkpoint/checkpoint_with_human_in_the_loop.py:330-332`.
- `run(responses={...}, checkpoint_id=..., stream=True)` — "restore then send" — is explicitly
  allowed (`_workflow.py:962-967`, `:987-1010`). Reference sample:
  `samples/03-workflows/orchestrations/handoff_with_tool_approval_checkpoint_resume.py:222-246`.
- Restore requires a matching `graph_signature_hash` (`_runner.py:312-317`), i.e. identical
  topology, participant names and start agent.

### The keying problem, and the experiment that settled it

Checkpoints can only be filtered by `workflow_name` — there is deliberately **no** per-instance id
(`_checkpoint.py:35-40`, `:157`). So either every session gets its own `workflow_name`, or the
bridge maintains its own `session_id -> checkpoint_id` map.

Per-session `workflow_name` is only viable if the name does not participate in the graph signature.
It does not — verified by building two identical handoff workflows with different names:

```
name1 = handoff-sessionA | name2 = handoff-sessionB
sig1  = b74a1cc49fc31918634c6065a192f45d1dbaf2637ff54f99ed12542dbb2ecb3f
sig2  = b74a1cc49fc31918634c6065a192f45d1dbaf2637ff54f99ed12542dbb2ecb3f
SIGNATURES MATCH: True
```

**Decision: `workflow_name = f"{orchestrator_id}::{session_id}"`.** The checkpoint namespace *is*
the session. No side map, no cross-session bleed, and `get_latest(workflow_name=...)` becomes the
whole resume lookup.

**Caveat to honour:** `iteration_count` is not unique and `get_latest` sorts by timestamp
(`_checkpoint.py:60-71`, `:227-231`). Resume must select the newest checkpoint whose
`pending_request_info_events` is non-empty, not blindly the newest.

## Isolated vs shared sessions

The user identified two shapes. They map onto genuinely different MAF APIs, not a flag:

| Shape | Meaning | MAF mechanism |
|---|---|---|
| **Shared** | One conversation, every agent in the network sees all of it; handoffs move who is answering. | The handoff `Workflow`. Already built. Context is shared *by construction* — see the WS12 pattern table. |
| **Isolated** | User talks to exactly one agent. No other agent sees it. | No workflow at all: `agent.run(messages, stream=True, session=session)` (`_agents.py:1849-1881`) with an `AgentSession` (`_sessions.py:1717`) persisted via `to_dict`/`from_dict` (`:1757`, `:1774`). |

Sentinel encoding, extending the existing `remote:<server>:<orchestrator>[:<participant>]` without
breaking it:

```
remote:<server>:<orch>                 shared, default start agent   (unchanged)
remote:<server>:<orch>:<participant>   shared, start at participant  (unchanged, WS10)
remote:<server>:<orch>:<participant>:solo   isolated, that agent only   (new)
```

A trailing mode segment keeps every existing sentinel valid and parsing a plain split.

## Detach and rejoin — the resulting model

No new TUI process, no detached server (see `investigation-remote-session-lifecycle.md` for why
neither helps). Rejoining becomes a *reconnect*:

1. User picks a remote session from the picker → OpenCode navigates to it.
2. First turn opens a WebSocket carrying `session_id`.
3. The bridge finds a checkpoint for `<orch>::<session_id>`, restores it into a fresh `Workflow`,
   and captures the re-emitted `request_id`.
4. The turn is delivered as `run(responses={request_id: ...}, checkpoint_id=..., stream=True)`.

Because the checkpoint is on disk, this survives the socket closing, the TUI exiting, and the
bridge container restarting (given a mounted volume). It also removes today's *"interrupting a
remote turn ends the conversation"* deviation for free.

---

## Workstreams

### WS14 — durable MAF conversations

Bridge-side checkpointing and resume. **This is the enabler; everything else is UI.**

Change surface:
- `app/orchestrator.py` — `build(...)` takes `session_id`; `HandoffBuilder(name=...)` becomes
  per-session; `.with_checkpointing(storage)`.
- `app/checkpoints.py` *(new)* — `FileCheckpointStorage` singleton rooted at
  `MAF_CHECKPOINT_DIR` (default `/data/checkpoints`); `latest_resumable(workflow_name)` applying
  the non-empty-pending-requests rule.
- `app/server.py` — on connect, attempt restore; hold `checkpoint_id` for the first
  `run(responses=..., checkpoint_id=...)`; report resume in the manifest/telemetry.
- `docker-compose.yml` — named volume for the checkpoint dir.
- `app/protocol.py` — `resumable: bool` on the manifest entry; a `session_resumed` server frame so
  the client can tell the user it rejoined.

Definition of Done:
- Talk to an agent, mention a fact, close the socket, reconnect with the same `session_id`, and the
  agent still knows the fact.
- The same holds across a **bridge container restart**.
- A session id with no checkpoint starts fresh rather than erroring.

### WS15 — remote session picker

The sessions already exist; this is presentation.

Change surface:
- `packages/tui/src/feature-plugins/sidebar/remote-sessions.tsx` *(new)* — registers the
  `sidebar_content` slot (pattern: `sidebar/mcp.tsx:120-129`), lists sessions whose `workspaceID`
  parses as remote, grouped by agent, current session highlighted.
- `packages/tui/src/feature-plugins/builtins.ts` — register it.
- A picker entry so a session can be chosen by keyboard, reusing `loadDialogSessionList`
  (`dialog-session-list.tsx:33`) with a client-side filter on `parseRemoteWorkspaceID`.

Definition of Done:
- With at least two sessions bound to remote agents, the sidebar lists both under their agent.
- Selecting one navigates to it and its transcript replays.
- Sending a turn continues the *same* MAF conversation (requires WS14).

### WS16 — isolated (solo) sessions

Depends on the WS14 persistence pattern.

Change surface:
- Sentinel: `:solo` segment in both `remote.ts` and the TUI's `util/remote-agent.ts`.
- `app/server.py` — a no-workflow path driving `agent.run(..., session=...)`.
- `app/sessions.py` *(new)* — `AgentSession` persistence via `to_dict`/`from_dict`.
- `/agent` picker — offer "talk privately" alongside the network entry.

Deferred until WS14 and WS15 land, since it duplicates their persistence and picker work.

---

## Open risk

`AgentExecutor.on_checkpoint_save` warns that *"if the session uses service-side storage, the full
session state may not be serialized locally"* (`_agent_executor.py:322-324`); only the
`service_session_id` pointer is kept (`_sessions.py:1769`). Whether our OpenAI chat client keeps
history locally in `full_conversation` or relies on a server-side conversation could not be
determined from the source.

**This is exactly what WS14's Definition of Done tests**, so it will be settled empirically by the
first cross-process resume rather than reasoned about further.
