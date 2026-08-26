import { Config } from "@opencode-ai/core/config"
import { RemoteAgentManifest } from "@opencode-ai/core/remote-agent/manifest"
import { SessionRunnerRemote } from "@opencode-ai/core/session/runner/remote"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { RemoteAgentServerNotFoundError, SelectPayload, SteerPayload } from "../groups/remote-agent"

export const remoteAgentHandlers = HttpApiBuilder.group(InstanceHttpApi, "remote-agent", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const session = yield* Session.Service

    // Reads the current request's Location's remote_agent config (a Location-scoped core
    // config field), mirroring the SessionRunnerRemote resolution logic in packages/core.
    // Must be re-evaluated per request (not hoisted) since InstanceState.context is request-scoped.
    const currentServers = Effect.fnUntraced(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        return Config.latest(entries, "remote_agent")?.servers ?? []
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
    })

    const list = Effect.fn("RemoteAgentHttpApi.list")(function* () {
      const servers = yield* currentServers()

      return yield* Effect.forEach(servers, (server) =>
        Effect.gen(function* () {
          const manifest = yield* RemoteAgentManifest.fetchManifest(server).pipe(
            Effect.map((value): { manifest?: typeof value; error?: string } => ({ manifest: value })),
            Effect.catch((cause) => Effect.succeed({ error: cause.message })),
          )
          return {
            id: server.id,
            url: server.url,
            disabled: server.disabled ?? false,
            ...manifest,
          }
        }),
      )
    })

    const select = Effect.fn("RemoteAgentHttpApi.select")(function* (ctx: { payload: typeof SelectPayload.Type }) {
      const servers = yield* currentServers()
      const server = servers.find((candidate) => candidate.id === ctx.payload.serverID && candidate.disabled !== true)
      if (!server)
        return yield* new RemoteAgentServerNotFoundError({
          name: "RemoteAgentServerNotFoundError",
          data: { message: `Unknown or disabled remote agent server: ${ctx.payload.serverID}` },
        })

      if (ctx.payload.participantID !== undefined) {
        const manifest = yield* RemoteAgentManifest.fetchManifest(server).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        const orchestrator = manifest?.orchestrators.find((entry) => entry.id === ctx.payload.orchestratorID)
        if (!orchestrator?.participants.some((entry) => entry.id === ctx.payload.participantID))
          return yield* new RemoteAgentServerNotFoundError({
            name: "RemoteAgentServerNotFoundError",
            data: {
              message: `Unknown participant '${ctx.payload.participantID}' on orchestrator '${ctx.payload.orchestratorID}'`,
            },
          })
      }

      const workspaceID = WorkspaceV2.ID.make(
        SessionRunnerRemote.remoteWorkspaceID(
          ctx.payload.serverID,
          ctx.payload.orchestratorID,
          ctx.payload.participantID,
        ),
      )
      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID, workspaceID }
    })

    // `steerToAgent` reads SessionRunnerRemote's module-level connection map rather than a
    // Location-scoped service, so it needs no Location provision here — a Session's open remote
    // socket is reachable from any entry point, including the V1 prompt path that owns it.
    const steer = Effect.fn("RemoteAgentHttpApi.steer")(function* (ctx: { payload: typeof SteerPayload.Type }) {
      const delivered = yield* SessionRunnerRemote.steerToAgent(ctx.payload.sessionID, ctx.payload.agentID)
      return { delivered }
    })

    return handlers.handle("list", list).handle("select", select).handle("steer", steer)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
