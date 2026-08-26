export * as SessionRunnerRemote from "./remote"

import { Effect, Layer } from "effect"
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
import { RemoteAgentError, Service } from "./index"

/** Prefix identifying a remote-orchestrator Location, e.g. `remote:bridge-1:support`. */
const WORKSPACE_ID_PREFIX = "remote:"

export const isRemoteWorkspaceID = (workspaceID: string | undefined): workspaceID is string =>
  workspaceID !== undefined && workspaceID.startsWith(WORKSPACE_ID_PREFIX)

export const remoteWorkspaceID = (serverID: string, orchestratorID: string) =>
  `${WORKSPACE_ID_PREFIX}${serverID}:${orchestratorID}`

export const parseRemoteWorkspaceID = (workspaceID: string) => {
  const rest = workspaceID.slice(WORKSPACE_ID_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator < 0) return undefined
  return { serverID: rest.slice(0, separator), orchestratorID: rest.slice(separator + 1) }
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

const toWebSocketURL = (baseURL: string, orchestratorID: string) =>
  `${baseURL.replace(/^http/, "ws").replace(/\/$/, "")}/agents/${orchestratorID}/session`

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
const connections = new Map<SessionSchema.ID, RemoteConnection>()

/**
 * Best-effort nudge asking the remote orchestrator's active participant to hand off to
 * `agentID`. Advisory only, per WS1's `SteerToAgentFrame` docstring: resolves once the frame is
 * sent, not once a handoff actually happens — the actual outcome is still observed via the
 * normal `handoff` frame relayed as an inline text segment in `runTurn`. No-ops if the Session
 * has no open remote connection (e.g. it hasn't sent a first turn yet, or was interrupted).
 */
export const steerToAgent = (sessionID: SessionSchema.ID, agentID: string) =>
  Effect.sync(() => {
    const connection = connections.get(sessionID)
    if (!connection) return false
    connection.send(RemoteProtocol.SteerToAgentFrame.make({ type: "steer_to_agent", agent_id: agentID }))
    return true
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const db = (yield* Database.Service).db

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
    ) {
      const existing = connections.get(sessionID)
      if (existing) return existing
      const baseURL = yield* resolveServerURL(serverID)
      const connection = yield* connect(toWebSocketURL(baseURL, orchestratorID))
      connections.set(sessionID, connection)
      return connection
    })

    /** Bridges one remote turn's frames into the same SessionEvent stream the local runner emits. */
    const runTurn = Effect.fn("SessionRunner.remote.runTurn")(function* (
      sessionID: SessionSchema.ID,
      orchestratorID: string,
      connection: RemoteConnection,
      text: string,
    ) {
      connection.send(RemoteProtocol.UserMessageFrame.make({ type: "user_message", text }))
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
            // Full local execution is WS3's scope; stub a rejection so the remote turn is never
            // left hanging on a pending tool call it will never receive a result for.
            connection.send(
              RemoteProtocol.ToolResultFrame.make({
                type: "tool_result",
                call_id: frame.call_id,
                output: "error: remote tool-call bridging is not implemented yet (see WS3)",
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

      const connection = yield* connectionFor(input.sessionID, target.serverID, target.orchestratorID)
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
  deps: [EventV2.node, SessionStore.node, Location.node, Config.node, Database.node],
})
