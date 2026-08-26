import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { RemoteAgentManifest } from "@opencode-ai/core/remote-agent/manifest"
import { it } from "./lib/effect"

describe("RemoteAgentManifest.fetchManifest", () => {
  it.effect("fetches and decodes a well-formed manifest", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({
              orchestrators: [
                {
                  id: "support",
                  name: "Support handoff",
                  description: "Triage/billing/refunds handoff group",
                  participants: [{ id: "triage", name: "Triage" }],
                },
              ],
            }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const manifest = yield* RemoteAgentManifest.fetchManifest({ id: "bridge-1", url: server.url.toString() })
          expect(manifest.orchestrators).toHaveLength(1)
          expect(manifest.orchestrators[0]?.id).toBe("support")
        }),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.effect("fails with ManifestFetchError on a non-2xx response", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) })),
      (server) =>
        Effect.gen(function* () {
          const failure = yield* RemoteAgentManifest.fetchManifest({
            id: "bridge-1",
            url: server.url.toString(),
          }).pipe(Effect.flip)
          expect(failure).toMatchObject({ _tag: "RemoteAgentManifest.FetchError", serverID: "bridge-1" })
        }),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.effect("fails with ManifestFetchError on a malformed manifest body", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => Response.json({ orchestrators: "not-an-array" }) })),
      (server) =>
        Effect.gen(function* () {
          const failure = yield* RemoteAgentManifest.fetchManifest({
            id: "bridge-1",
            url: server.url.toString(),
          }).pipe(Effect.flip)
          expect(failure).toMatchObject({ _tag: "RemoteAgentManifest.FetchError", serverID: "bridge-1" })
        }),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )
})
