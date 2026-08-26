export * as ConfigRemoteAgent from "./remote-agent"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

/** One externally-hosted agent execution backend (e.g. a MAF handoff-bridge container). */
export class Server extends Schema.Class<Server>("ConfigV2.RemoteAgent.Server")({
  id: Schema.String.annotate({
    description: "Stable identifier used to address this server as remote:<id>:<orchestratorID>",
  }),
  url: Schema.String.annotate({
    description: "Base HTTP(S) URL of the remote agent bridge server, e.g. http://localhost:8000",
  }),
  timeout: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for the manifest fetch or a turn to start streaming.",
  }),
  disabled: Schema.Boolean.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.RemoteAgent")({
  servers: Server.pipe(Schema.Array, Schema.optional).annotate({
    description: "Remote agent bridge servers this workspace can connect to.",
  }),
}) {}
