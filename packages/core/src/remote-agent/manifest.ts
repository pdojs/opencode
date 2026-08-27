export * as RemoteAgentManifest from "./manifest"

import { Effect } from "effect"
import { Data } from "effect"
import { RemoteProtocol } from "../session/execution/remote-protocol"

export class ManifestFetchError extends Data.TaggedError("RemoteAgentManifest.FetchError")<{
  readonly serverID: string
  readonly url: string
  readonly message: string
}> {}

/**
 * Queries a configured remote agent server's `GET /agents/manifest` endpoint live. Used by the
 * `/agent` picker (WS4) to list available orchestrators per server, and available for the CLI/
 * server routes that expose remote-agent selection to the TUI.
 */
export const fetchManifest = (server: { readonly id: string; readonly url: string; readonly timeout?: number }) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${server.url.replace(/\/$/, "")}/agents/manifest`, {
        signal: server.timeout ? AbortSignal.any([signal, AbortSignal.timeout(server.timeout)]) : signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    },
    catch: (cause) =>
      new ManifestFetchError({
        serverID: server.id,
        url: server.url,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.flatMap((body) => {
      const manifest = RemoteProtocol.decodeManifest(body)
      if (!manifest)
        return new ManifestFetchError({ serverID: server.id, url: server.url, message: "Malformed manifest response" })
      return Effect.succeed(manifest)
    }),
  )
