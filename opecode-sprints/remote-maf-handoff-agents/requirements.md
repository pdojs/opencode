# Remote MAF Handoff Agents in OpenCode — Requirements

## Roles (confirmed with user)

- **OpenCode** (this repo) = the harness/TUI the user drives. All new interactive UX lives here.
- **Microsoft Agent Framework (MAF)**, `/Users/pdops/projects/agent-framework` = the agentic app itself: a **handoff-pattern Workflow** (`agent_framework_orchestrations/_handoff.py`) running **inside a Docker container**. Agents "live" there.
- **Phoenix**, `/Users/pdops/projects/phoenix` = **passive OTel telemetry only** (traces/spans via `openinference-instrumentation-agent-framework`). Not part of the interactive path. PXI (Phoenix's own terminal, `phoenix-cli`) is unrelated and out of scope — confirmed with user this is a different tool from OpenCode.

## Goal

From OpenCode's TUI, run `/agent` to browse and select a MAF handoff-orchestrator running in a Docker container, stream that orchestrator's live turn-by-turn output (including which sub-agent currently holds the handoff) into the session view, steer it with normal prompt input mid-conversation, and have any tool call the remote orchestrator issues (shell, file edit) execute against the user's actual local workspace through OpenCode's existing tool registry and permission system.

## Problem

OpenCode today has no concept of an externally-hosted agent execution backend:
- `Agent.Info`/`Agent.Service` (`packages/opencode/src/agent/agent.ts:34-79`) model only in-process subagents (built-in or config-defined), selected via the existing `/agents` command → `<DialogAgent />` (`packages/tui/src/app.tsx:679-686`, `packages/tui/src/component/dialog-agent.tsx`).
- `SessionExecution.Service` (`packages/core/src/session/execution.ts:9-20`) and its local implementation (`packages/core/src/session/execution/local.ts`) only resolve a Session's `Location` to a **local** runner (`packages/core/src/session/runner/index.ts`). No remote `Location` variant exists.
- Tool execution (`packages/opencode/src/tool/registry.ts`) always spawns local subprocesses (`ShellTool`, `EditTool`, etc.) for the *local* agent's own tool calls. There is no pathway for an **externally-running** agent process to request a tool run against the local workspace.
- No Docker/remote-execution concept exists anywhere in `packages/opencode`, `packages/core`, or `packages/tui` (confirmed by repo-wide search — only unrelated `packages/containers/*` build tooling and incidental shell-command-arity docker mentions).

Net effect: a MAF handoff workflow in a container today is "fire and forget" — no live streaming, no steering, no way for its tool calls to touch the user's real files/terminal.

## Decisions locked with user

1. Transport for interactive chat + tool bridge: **new lightweight FastAPI/WebSocket server** inside the container wrapping the MAF `Workflow` (not MAF's AG-UI bridge, not Phoenix/PXI).
2. Agent discovery: **each container exposes a `GET /agents/manifest` endpoint**; OpenCode queries it live on connect (no static registry file as source of truth, though the container *address* itself is configured statically — see design-proposal.md WS2).
3. Tool-call bridging: **a WebSocket "tool-bridge" channel** — the container pushes tool-call requests (shell, file read/write) over it; OpenCode executes them locally against the real workspace via the existing tool registry/permission system, and returns results over the same channel. Chosen over channel-per-message-type and over a reverse local sidecar for symmetry with the chat stream and reuse of the existing PTY-style WS tracker pattern.
4. Naming: reuse the existing `<DialogAgent />` picker, extended with a "Remote Agents" section populated from container manifests, and add `/agent` (singular) as a new slash alias on that same command entry — distinct from today's `/agents` (plural) which still means "switch local subagent." Both open the same unified dialog; `/agent` additionally pre-filters/scrolls to the Remote section. This avoids a colliding second dialog implementation while satisfying the literal `/agent` command ask.
5. Phoenix/OTel wiring (telemetry only, no interactive coupling) is in scope as a container-side concern (WS1) but does not touch OpenCode code.
6. Picker UX: the agent picker must visually separate three groups, using `DialogSelect`'s existing `category` field (`packages/tui/src/ui/dialog-select.tsx`) — **Native** (built-in TUI agents, `Agent.Info.native === true`), **Workspace** (agents defined via project config/`.md` frontmatter, `Agent.Info.native === false`), and **Remote** (MAF containers from WS2's manifest client). This replaces today's flat single-list rendering and its overloaded `description: item.native ? "native" : item.description` special-case (`dialog-agent.tsx:15`), which only hinted at native-vs-not textually and had no concept of "remote" at all.

## Definition of Done

- Running `/agent` in OpenCode's prompt opens a dialog listing agents in three visually separated, headed sections — **Native**, **Workspace**, **Remote** — where Remote is populated from any configured MAF containers (queried live via `GET /agents/manifest`), each remote entry showing the container's declared orchestrator name/description.
- Selecting a remote orchestrator binds the current Session's `Location` to that remote backend; the next user message is admitted through the normal `SessionV2.prompt(...)` durable-input path and produces a running turn serviced by the container instead of a local LLM call.
- The TUI renders the remote orchestrator's streamed output incrementally (token/segment deltas) through the existing message-rendering surface, with a visible indicator of which named sub-agent currently holds the handoff (e.g. "Agent B is responding") sourced from `HandoffSentEvent`-equivalent frames relayed from the container.
- The user can type a follow-up message while the remote turn is in progress and have it steer/queue exactly as a local session does today (reusing existing steer/queue semantics from `SessionV2.prompt`), with no dedicated "remote mode" input UX.
- When the remote orchestrator's active sub-agent issues a shell command or file edit, that command actually runs in the user's local workspace directory (verified by observing a real file change / real command stdout in the workspace, not a container-local echo), gated by the same permission prompts local tool calls already trigger.
- Killing/interrupting the session from the TUI (existing interrupt command) stops the remote turn and is observable as the WebSocket tool-bridge/chat channel closing or the container acknowledging cancellation.
- Phoenix, run separately via its own docker-compose, shows OTel spans for the container's workflow execution — verified independently of the OpenCode interactive path (no code in OpenCode touches Phoenix).

See `design-proposal.md` for investigation, root cause, and per-workstream resolution, and `wbs.md` for the dependency graph, branch names, and implementation order.
