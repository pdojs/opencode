# Investigation — remote session lifecycle and the "one TUI per remote agent" proposal

Triggered by two observations:

> Once I'm logged in to the remote agents, I can't switch back to the native build / plan agent.

> Should we treat a remote agent session like VS Code devcontainers work? When we choose a remote
> agent, a new TUI is opened [...] The challenge is when we want to trigger the remote agents and
> close the TUI but offer the user an option to log back into the session.

The stated hypothesis was that a session and a terminal get tied to a remote live session that
cannot be gracefully backgrounded. That is **not** what the code does. The findings below are
grounded in the current tree at `3beee6fec`.

---

## Finding 1 — the binding is per-session, not per-TUI

`experimental.remoteAgent.select` writes a sentinel workspace id onto the **session** row:

- `packages/opencode/src/server/routes/instance/httpapi/handlers/remote-agent.ts:71-81` —
  `session.setWorkspace({ sessionID, workspaceID: "remote:<server>:<orch>[:<participant>]" })`.
- `packages/core/src/session/runner/remote.ts:213` — the live WebSocket map is keyed by
  `SessionSchema.ID`.

Nothing is keyed by terminal, TUI instance, or process. A native session and a remote session
already coexist in one TUI: `SessionRunnerRemote.run` bails out unless the session's own Location
carries a `remote:` workspace id (`remote.ts:437`).

**Consequence:** the session is already the isolation boundary that the devcontainer proposal
wants a TUI to be.

## Finding 2 — the binding is one-way; that is the actual bug

Three facts combine into the reported symptom:

1. `setWorkspace` overwrites `workspaceID` and does not retain the previous value
   (`packages/opencode/src/session/session.ts:814-821`).
2. The HttpApi group exposes only `list`, `select` and `steer`
   (`packages/opencode/src/server/routes/instance/httpapi/groups/remote-agent.ts:76-101`).
   **There is no unbind operation.**
3. Picking a local agent in the TUI only sets the local agent name and returns
   (`packages/tui/src/component/dialog-agent.tsx:103-107`). It never touches the workspace.

So selecting `build` on a remote-bound session changes a label while the session stays bound to
`remote:...`. The prompt path keeps routing remotely
(`packages/opencode/src/session/prompt.ts:1190`), which is why the agent "switches back to build"
in the status bar but still behaves remotely — and why the earlier
`Workspace not found: remote:demo-bridge:support` and *"Workspace Unavailable — restore this
session into a new workspace"* prompts appeared: the sentinel is not a real registered workspace,
so generic workspace-resolution paths reject it.

**This needs no architectural change.** It needs a `release` operation. See WS13.

## Finding 3 — the TUI owns the server, so closing it does kill the conversation

This is the one part of the hypothesis that holds, but the cause is not session/terminal coupling:

- `packages/opencode/src/cli/cmd/tui.ts:208` — every TUI invocation does `new Worker(file)` and
  runs the whole server inside that worker.
- `packages/opencode/src/cli/cmd/tui.ts:222-229` — `stop()` calls `shutdown` then
  `worker.terminate()`.
- The `connections` map (`remote.ts:213`) is module-level **inside that worker**, so it dies with
  it, taking every open bridge WebSocket with it.

`--port` / `--hostname` does not detach: it only makes that same worker listen on TCP
(`tui.ts:236-247`). There is no attach-to-an-already-running-server path in the TUI command.

**Consequence for the devcontainer proposal:** two TUIs on one project means two server workers,
each with its own independent `connections` map, over one shared on-disk session store. Nothing
locks a session to a worker, so two TUIs opening the same remote session would produce two MAF
workflows for one session. The proposal therefore *weakens* the isolation it is trying to create.

## Finding 4 — the bridge cannot resume a conversation, but MAF can

Today the MAF workflow is constructed per WebSocket in `session(...)`
(`test/remote-maf-handoff-agents/app/server.py:57`), and `session_id` is accepted but used only
as a telemetry attribute (`app/server.py:66`, `app/server.py:160`). Dropping the socket destroys
the workflow — the documented WS2 deviation.

MAF itself supports durable resume:

- `HandoffBuilder.with_checkpointing(checkpoint_storage)` —
  `agent-framework/python/packages/orchestrations/agent_framework_orchestrations/_handoff.py:850`
- The handoff executor already serializes its state:
  `on_checkpoint_save` / `on_checkpoint_restore` — `_handoff.py:550-559`
- `FileCheckpointStorage` for durable on-disk checkpoints —
  `agent-framework/python/packages/core/agent_framework/_workflows/_checkpoint.py:249`
- `workflow.run(..., checkpoint_id=...)` restores — `_workflow.py:241`, `_workflow.py:655`

So "close the client, come back to the conversation later" is achievable by keying checkpoints on
`session_id`. It is not a dead end.

---

## Verdict on the proposed UX

| Requirement | Supported today? | Assessment |
|---|---|---|
| (A) Selecting a remote agent opens a dedicated TUI | Possible, not advisable | Wrong grain. Binding is per-session (Finding 1), and each extra TUI adds an unsynchronised server worker (Finding 3). |
| (B) Switching back to native means opening another TUI | Unnecessary | Sessions already isolate. The gap is a missing `release`, not a missing process (Finding 2). |
| (C) Close the client, log back into the remote session later | **No** | Two independent blockers: the server dies with the TUI (Finding 3), and the bridge has no resume (Finding 4). Both are fixable; neither is fixed by opening more TUIs. |

**Recommendation: do not adopt the devcontainer model.** It imposes a per-process boundary on a
system whose boundary is already the session, and it makes (C) harder — more workers, more
independent connection maps, still no resume.

Two workstreams deliver the same user experience without it:

- **WS13 — release a remote binding.** Restores the "switch back to native" flow. Small.
- **WS14 — checkpoint-backed resume keyed by `session_id`.** Delivers (C) properly, and as a side
  effect removes the current "interrupting a remote turn ends the conversation" limitation.
  Larger; requires a detached-server story as well as bridge checkpointing.

### On detaching the server

WS14's client half is a separate concern from its bridge half. Once the bridge can resume from a
checkpoint, a TUI restart no longer needs the *server* to survive — reattaching re-establishes the
socket and restores the workflow. That makes bridge checkpointing the higher-value half, and a
detached `opencode serve` an optimisation rather than a prerequisite.
