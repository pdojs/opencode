import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { RemoteAgentPaths } from "../../src/server/routes/instance/httpapi/groups/remote-agent"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)

type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${route}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

describe("remote-agent HttpApi", () => {
  it.instance(
    "lists configured remote agent servers with an unreachable-server error",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const response = yield* request(handler, RemoteAgentPaths.list, tmp.directory)

        expect(response.status).toBe(200)
        const body = yield* json<Array<{ id: string; url: string; disabled: boolean; error?: string }>>(response)
        expect(body).toHaveLength(1)
        expect(body[0].id).toBe("bridge-1")
        expect(body[0].disabled).toBe(false)
        expect(body[0].error).toBeDefined()
      }),
    // `remote_agent` is part of the core V2 config schema (packages/core/src/config.ts), not
    // the V1 `ConfigV1.Info` this fixture's `config` option is typed against. The fixture only
    // JSON-serializes the object to disk, and core's V2 config loader decodes it independently
    // of the V1 loader, so the cast below is safe and this still exercises the real code path.
    {
      config: {
        remote_agent: {
          servers: [{ id: "bridge-1", url: "http://127.0.0.1:1" }],
        },
      } as never,
    },
  )

  it.instance(
    "rejects selecting an unknown remote agent server",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const response = yield* request(handler, RemoteAgentPaths.select, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: "ses_missing", serverID: "unknown", orchestratorID: "support" }),
        })

        expect(response.status).toBe(400)
      }),
    {
      config: {
        remote_agent: {
          servers: [{ id: "bridge-1", url: "http://127.0.0.1:1" }],
        },
      } as never,
    },
  )

  it.instance(
    "reports an undelivered steer when the session has no open remote connection",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const response = yield* request(handler, RemoteAgentPaths.steer, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: "ses_missing", agentID: "refunds" }),
        })

        // Steering is advisory and rides a Session's live turn socket, so a session with no
        // turn in flight is a normal 200 with `delivered: false` rather than an error — the
        // TUI surfaces that distinction as a "nothing to steer" warning.
        expect(response.status).toBe(200)
        const body = yield* json<{ delivered: boolean }>(response)
        expect(body.delivered).toBe(false)
      }),
    {
      config: {
        remote_agent: {
          servers: [{ id: "bridge-1", url: "http://127.0.0.1:1" }],
        },
      } as never,
    },
  )

  it.instance(
    "releases a bound session back to the local project",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()

        const created = yield* request(handler, SessionPaths.create, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        const session = yield* json<{ id: string; workspaceID?: string }>(created)
        const localWorkspaceID = session.workspaceID

        const selected = yield* request(handler, RemoteAgentPaths.select, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, serverID: "bridge-1", orchestratorID: "support" }),
        })
        expect(selected.status).toBe(200)
        expect((yield* json<{ workspaceID: string }>(selected)).workspaceID).toBe("remote:bridge-1:support")

        const released = yield* request(handler, RemoteAgentPaths.release, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(released.status).toBe(200)
        expect(yield* json<{ released: boolean }>(released)).toMatchObject({ released: true })

        // The binding must be gone from the session itself, not just reported as released:
        // routing follows the session's Location, so anything left behind keeps it remote.
        const after = yield* request(handler, `/session/${session.id}`, tmp.directory)
        expect((yield* json<{ workspaceID?: string }>(after)).workspaceID).toBe(localWorkspaceID)

        // Releasing an already-local session is a no-op rather than an error, so a user picking
        // a local agent twice does not see a spurious failure.
        const again = yield* request(handler, RemoteAgentPaths.release, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(yield* json<{ released: boolean }>(again)).toMatchObject({ released: false })
      }),
    {
      config: {
        remote_agent: {
          servers: [{ id: "bridge-1", url: "http://127.0.0.1:1" }],
        },
      } as never,
    },
  )
})
