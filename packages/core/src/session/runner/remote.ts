export * as SessionRunnerRemote from "./remote"

import { Effect, Layer } from "effect"
import { AgentV2 } from "../../agent"
import { LLMEvent } from "@opencode-ai/llm"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { makeLocationNode } from "../../effect/app-node"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { createLLMEventPublisher } from "./publish-llm-event"
import { RemoteProtocol } from "../execution/remote-protocol"
import { RemoteToolBridge } from "./remote-tool-bridge"
import { ToolRegistry } from "../../tool/registry"
import { RemoteAgentError, Service } from "./index"

/** Prefix identifying a remote-orchestrator Location, e.g. `remote:bridge-1:support`. */
const WORKSPACE_ID_PREFIX = "remote:"

/**
 * Phrasing for an in-conversation participant switch. Advisory, exactly like a steer: MAF's
 * handoff routing is decided by the active agent's own tool calls, so this asks rather than
 * commands (see RemoteProtocol.SteerToAgentFrame and design-proposal.md WS1).
 */
const REDIRECT_INSTRUCTION = (agentID: string) =>
  `[The user has switched to '${agentID}'. Hand off to '${agentID}' now, then answer as that agent.]`

export const isRemoteWorkspaceID = (workspaceID: string | undefined): workspaceID is string =>
  workspaceID !== undefined && workspaceID.startsWith(WORKSPACE_ID_PREFIX)

export const remoteWorkspaceID = (serverID: string, orchestratorID: string, participantID?: string) =>
  [WORKSPACE_ID_PREFIX + serverID, orchestratorID, participantID].filter((part) => part !== undefined).join(":")

export const parseRemoteWorkspaceID = (workspaceID: string) => {
  const parts = workspaceID.slice(WORKSPACE_ID_PREFIX.length).split(":")
  if (parts.length < 2 || parts.length > 3) return undefined
  if (parts.some((part) => part === "")) return undefined
  return { serverID: parts[0]!, orchestratorID: parts[1]!, participantID: parts[2] as string | undefined }
}

/** Finds the newest user-authored turn text in already-recorded history, for sending to the remote agent. */
const findLatestUserText = (entries: ReadonlyArray<{ readonly message: { type: string; text?: string } }>) => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]!.message
    if ((message.type === "user" || message.type === "synthetic") && typeof message.text === "string")
      return message.text
  }
  return undefined
}

const toWebSocketURL = (
  baseURL: string,
  orchestratorID: string,
  participantID?: string,
  sessionID?: string,
) => {
  const query = new URLSearchParams()
  if (participantID) query.set("start_agent", participantID)
  // Correlates the bridge's OTel spans with this Session so a trace in Phoenix can be traced
  // back to the conversation that produced it.
  if (sessionID) query.set("session_id", sessionID)
  const search = query.toString()
  return (
    `${baseURL.replace(/^http/, "ws").replace(/\/$/, "")}/agents/${orchestratorID}/session` +
    (search ? `?${search}` : "")
  )
}

/**
 * One long-lived WS connection per Session, held for the Location's lifetime so the remote
 * MAF workflow instance (created per-connection server-side) keeps its own conversation memory
 * across turns. Closed on the owning run() fiber's interruption — a documented simplification:
 * interrupting a remote turn ends that remote conversation rather than merely pausing it, since
 * MAF's handoff workflow has no resume-by-id API today (see design-proposal.md WS2 deviations).
 */
class RemoteConnection {
  private queue: Array<RemoteProtocol.ServerFrame | { readonly closed: true }> = []
  private waiters: Array<() => void> = []
  /**
   * Whether a consumer is currently relaying frames for this connection. The bridge answers a
   * `steer_to_agent` frame with a *whole extra turn* (see the sample bridge's
   * `_frame_to_turn_text`), so a steer sent with no active relay would emit frames nobody
   * reads — they would sit in `queue` and be mis-attributed to the next prompt. Steering is
   * therefore refused unless a turn is in flight to absorb the response.
   */
  private turnActive = false
  /** Steer-induced turns sent during the current relay that it must still consume before settling. */
  private pendingSteerTurns = 0
  /** Participant the user re-targeted this session at, applied to the next user turn. */
  private pendingRedirect: string | undefined

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data)
      const frame = RemoteProtocol.decodeServerFrame(raw)
      if (frame) this.push(frame)
    })
    socket.addEventListener("close", () => this.push({ closed: true }))
    socket.addEventListener("error", () => this.push({ closed: true }))
  }

  private push(item: RemoteProtocol.ServerFrame | { readonly closed: true }) {
    this.queue.push(item)
    const waiter = this.waiters.shift()
    if (waiter) waiter()
  }

  send(frame: RemoteProtocol.ClientFrame) {
    this.socket.send(RemoteProtocol.encodeClientFrame(frame))
  }

  /**
   * Records that the user re-targeted this session at a different participant. Applied to the
   * next user turn rather than sent immediately: a steer frame is only safe mid-turn (the bridge
   * answers it with a whole extra turn, which would otherwise be stranded), and a participant
   * switch normally happens while the session is idle.
   *
   * Redirecting beats reconnecting because the MAF workflow — and therefore the entire shared
   * conversation every participant can see — lives for exactly as long as this socket.
   * Reconnecting to change the start agent would silently discard it.
   */
  redirectTo(agentID: string) {
    this.pendingRedirect = agentID
  }

  /** Sends the next user turn, folding in any pending participant redirect. */
  sendUserTurn(text: string) {
    const redirect = this.pendingRedirect
    this.pendingRedirect = undefined
    this.send(
      RemoteProtocol.UserMessageFrame.make({
        type: "user_message",
        text: redirect ? `${REDIRECT_INSTRUCTION(redirect)}\n\n${text}` : text,
      }),
    )
  }

  /** Marks the start of a relay. Returns false if one is already running for this connection. */
  beginTurn() {
    if (this.turnActive) return false
    this.turnActive = true
    this.pendingSteerTurns = 0
    return true
  }

  endTurn() {
    this.turnActive = false
    this.pendingSteerTurns = 0
  }

  /** Sends a steer frame, recording the extra turn the relay must consume. No-op when idle. */
  steer(agentID: string) {
    if (!this.turnActive) return false
    this.pendingSteerTurns += 1
    this.send(RemoteProtocol.SteerToAgentFrame.make({ type: "steer_to_agent", agent_id: agentID }))
    return true
  }

  /**
   * Called on `turn_complete`: reports whether the relay should keep consuming because a steer
   * issued during this turn has its own turn still to come.
   */
  consumeSteerTurn() {
    if (this.pendingSteerTurns === 0) return false
    this.pendingSteerTurns -= 1
    return true
  }

  /** Waits for and returns the next frame, or undefined once the socket has closed. */
  next(): Effect.Effect<RemoteProtocol.ServerFrame | undefined> {
    return Effect.callback<RemoteProtocol.ServerFrame | undefined>((resume) => {
      const attempt = () => {
        const item = this.queue.shift()
        if (item === undefined) {
          this.waiters.push(attempt)
          return
        }
        resume(Effect.succeed("closed" in item ? undefined : item))
      }
      attempt()
    })
  }

  close(reason: string) {
    try {
      this.socket.close(1000, reason)
    } catch {
      // socket may already be closed
    }
  }
}

/** Opens a fresh WS connection and waits for it to reach the OPEN state. */
const connect = (url: string) =>
  Effect.callback<RemoteConnection, RemoteAgentError>((resume) => {
    const socket = new WebSocket(url)
    const onOpen = () => {
      socket.removeEventListener("error", onError)
      resume(Effect.succeed(new RemoteConnection(socket)))
    }
    const onError = () => {
      socket.removeEventListener("open", onOpen)
      resume(Effect.fail(new RemoteAgentError({ message: `Failed to connect to remote agent at ${url}` })))
    }
    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
  })

/**
 * Module-level (not Location-scoped) so `steerToAgent` below can reach a Session's open
 * connection regardless of which Location instance created it — a Session always resolves to
 * the same Location ref, but callers of `steerToAgent` (WS4's UI action) don't hold a reference
 * to that Location's layer closure.
 */
type Bound = {
  readonly orchestratorURL: string
  readonly participantID: string | undefined
  readonly connection: RemoteConnection
}

const connections = new Map<SessionSchema.ID, Bound>()

export type Connection = RemoteConnection

/**
 * Shared connection accessor for callers outside this Location-scoped layer — notably the V1
 * prompt path's remote LLM stream, which drives the same per-Session socket so both entry
 * points reuse one remote MAF workflow instance instead of racing two conversations.
 */
export const openConnection = Effect.fn("SessionRunner.remote.openConnection")(function* (
  sessionID: SessionSchema.ID,
  orchestratorID: string,
  baseURL: string,
  participantID?: string,
) {
  const orchestratorURL = toWebSocketURL(baseURL, orchestratorID)
  const existing = connections.get(sessionID)

  if (existing && existing.orchestratorURL === orchestratorURL) {
    if (existing.participantID === participantID) return existing.connection
    // Same workflow, different participant. The whole conversation — which in a handoff network
    // every participant can see — lives in the MAF workflow behind this socket, so switching
    // agents must redirect the running conversation rather than start a new one. `start_agent`
    // is fixed at connect time, hence the in-conversation redirect on the next turn.
    if (participantID) existing.connection.redirectTo(participantID)
    connections.set(sessionID, { orchestratorURL, participantID, connection: existing.connection })
    return existing.connection
  }

  // A different orchestrator is a genuinely different workflow; nothing to carry over.
  if (existing) {
    existing.connection.close("rebound to a different remote orchestrator")
    connections.delete(sessionID)
  }
  const connection = yield* connect(toWebSocketURL(baseURL, orchestratorID, participantID, sessionID))
  connections.set(sessionID, { orchestratorURL, participantID, connection })
  return connection
})

export const closeConnection = (sessionID: SessionSchema.ID, reason: string) =>
  Effect.sync(() => {
    const existing = connections.get(sessionID)
    if (!existing) return
    existing.connection.close(reason)
    connections.delete(sessionID)
  })

/**
 * Resolves a configured, enabled remote agent server's base URL from an already-merged config
 * document. Separate from the Location-scoped layer below because the V1 prompt path reads
 * config through `ConfigV1` rather than this module's Location-scoped `Config.Service`.
 */
export const serverURLFromConfig = Effect.fn("SessionRunner.remote.serverURLFromConfig")(function* (
  config: {
    readonly remote_agent?: { readonly servers?: ReadonlyArray<{ id: string; url: string; disabled?: boolean }> }
  },
  serverID: string,
) {
  const server = config.remote_agent?.servers?.find(
    (candidate) => candidate.id === serverID && candidate.disabled !== true,
  )
  if (!server) return yield* new RemoteAgentError({ message: `Unknown or disabled remote agent server: ${serverID}` })
  return server.url
})

/**
 * Best-effort nudge asking the remote orchestrator's active participant to hand off to
 * `agentID`. Advisory only, per WS1's `SteerToAgentFrame` docstring: resolves once the frame is
 * sent, not once a handoff actually happens — the actual outcome is still observed via the
 * normal `handoff` frame relayed as an inline text segment in the turn's stream.
 *
 * Returns false (sending nothing) when the Session has no open remote connection, or has one
 * but no turn in flight. The bridge replies to a steer with a full extra turn, so steering an
 * idle connection would strand those frames and corrupt the next prompt's stream.
 */
export const steerToAgent = (sessionID: SessionSchema.ID, agentID: string) =>
  Effect.sync(() => connections.get(sessionID)?.connection.steer(agentID) ?? false)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const db = (yield* Database.Service).db
    const registry = yield* ToolRegistry.Service

    const getSession = Effect.fn("SessionRunner.remote.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const resolveServerURL = Effect.fn("SessionRunner.remote.resolveServerURL")(function* (serverID: string) {
      const entries = yield* config.entries()
      const info = Config.latest(entries, "remote_agent")
      const server = info?.servers?.find((candidate) => candidate.id === serverID && candidate.disabled !== true)
      if (!server) return yield* new RemoteAgentError({ message: `Unknown or disabled remote agent server: ${serverID}` })
      return server.url
    })

    const connectionFor = Effect.fn("SessionRunner.remote.connectionFor")(function* (
      sessionID: SessionSchema.ID,
      serverID: string,
      orchestratorID: string,
      participantID: string | undefined,
    ) {
      return yield* openConnection(sessionID, orchestratorID, yield* resolveServerURL(serverID), participantID)
    })

    /** Bridges one remote turn's frames into the same SessionEvent stream the local runner emits. */
    const runTurn = Effect.fn("SessionRunner.remote.runTurn")(function* (
      sessionID: SessionSchema.ID,
      orchestratorID: string,
      connection: RemoteConnection,
      text: string,
    ) {
      connection.sendUserTurn(text)
      const publisher = createLLMEventPublisher(events, {
        sessionID,
        agent: orchestratorID,
        model: { id: ModelV2.ID.make(orchestratorID), providerID: ProviderV2.ID.make("remote-agent") },
      })
      let activeAgent: string | undefined
      let textID = 0
      const endActiveText = Effect.fn("SessionRunner.remote.endActiveText")(function* () {
        if (activeAgent === undefined) return
        yield* publisher.publish({ type: "text-end", id: String(textID) })
      })
      let done = false
      while (!done) {
        const frame = yield* connection.next()
        if (!frame) return yield* new RemoteAgentError({ message: "Remote agent connection closed mid-turn" })
        switch (frame.type) {
          case "assistant_delta": {
            if (activeAgent !== frame.agent_id) {
              yield* endActiveText()
              activeAgent = frame.agent_id
              textID += 1
              yield* publisher.publish({ type: "text-start", id: String(textID) })
            }
            yield* publisher.publish({ type: "text-delta", id: String(textID), text: frame.text })
            break
          }
          case "handoff": {
            yield* endActiveText()
            activeAgent = undefined
            textID += 1
            const note = `↪ handoff: ${frame.source} → ${frame.target}`
            yield* publisher.publish({ type: "text-start", id: String(textID) })
            yield* publisher.publish({ type: "text-delta", id: String(textID), text: note })
            yield* publisher.publish({ type: "text-end", id: String(textID) })
            activeAgent = undefined
            break
          }
          case "tool_call": {
            yield* endActiveText()
            activeAgent = undefined
            yield* publisher.publish({ type: "tool-call", id: frame.call_id, name: frame.name, input: frame.arguments })
            const assistantMessageID = yield* publisher.assistantMessageID(frame.call_id)
            const settlement = yield* RemoteToolBridge.execute({
              registry,
              sessionID,
              agent: AgentV2.ID.make(orchestratorID),
              assistantMessageID,
              callID: frame.call_id,
              name: frame.name,
              arguments: frame.arguments,
            })
            yield* publisher.publish(
              LLMEvent.toolResult({
                id: frame.call_id,
                name: frame.name,
                result: settlement.result,
                output: settlement.output,
              }),
              settlement.outputPaths ?? [],
            )
            connection.send(
              RemoteProtocol.ToolResultFrame.make({
                type: "tool_result",
                call_id: frame.call_id,
                output: RemoteToolBridge.resultText(settlement.result),
              }),
            )
            break
          }
          case "turn_complete": {
            yield* endActiveText()
            yield* publisher.flush()
            done = true
            break
          }
          case "error": {
            yield* endActiveText()
            yield* publisher.failAssistant(frame.message)
            done = true
            break
          }
        }
      }
    })

    const run = Effect.fn("SessionRunner.remote.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const session = yield* getSession(input.sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      if (!isRemoteWorkspaceID(location.workspaceID)) return yield* Effect.interrupt
      const target = parseRemoteWorkspaceID(location.workspaceID)
      if (!target) return yield* Effect.die(`Malformed remote Location workspaceID: ${location.workspaceID}`)

      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return

      const cutoff = yield* EventV2.latestSequence(db, input.sessionID)
      if (hasSteer) yield* SessionInput.promoteSteers(db, events, input.sessionID, cutoff)
      else if (hasQueue) yield* SessionInput.promoteNextQueued(db, events, input.sessionID)

      const entries = yield* SessionHistory.entriesForRunner(db, input.sessionID, 0)
      const text = findLatestUserText(entries)
      if (text === undefined) return

      const connection = yield* connectionFor(
        input.sessionID,
        target.serverID,
        target.orchestratorID,
        target.participantID,
      )
      yield* runTurn(input.sessionID, target.orchestratorID, connection, text).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            connection.close("session interrupted")
            connections.delete(input.sessionID)
          }),
        ),
      )
    })

    return Service.of({ run })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, SessionStore.node, Location.node, Config.node, Database.node, ToolRegistry.node],
})
