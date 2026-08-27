import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { RemoteProtocol } from "@opencode-ai/core/session/execution/remote-protocol"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/experimental/remote-agent"

/** One configured remote agent server, with its live-fetched manifest or a fetch error message. */
export const ServerEntry = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  disabled: Schema.Boolean,
  manifest: Schema.optional(RemoteProtocol.Manifest),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "RemoteAgentServerEntry" })

export const SelectPayload = Schema.Struct({
  sessionID: SessionID,
  serverID: Schema.String,
  orchestratorID: Schema.String,
  // Binds the session directly to one participant of the orchestrator's handoff network rather
  // than to its default start agent. Handoffs still apply from wherever the conversation begins.
  participantID: Schema.optional(Schema.String),
  // Talks to `participantID` privately: no workflow, no handoffs, and a transcript separate from
  // the shared network conversation. Requires a participant, since the network as a whole is not
  // something one can talk to privately.
  solo: Schema.optional(Schema.Boolean),
})

export const SelectResponse = Schema.Struct({
  sessionID: SessionID,
  workspaceID: WorkspaceV2.ID,
})

export const ReleasePayload = Schema.Struct({
  sessionID: SessionID,
})

export const ReleaseResponse = Schema.Struct({
  sessionID: SessionID,
  /** The Location the Session was returned to, or undefined for the local project. */
  workspaceID: Schema.optional(WorkspaceV2.ID),
  /** False when the Session was not bound to a remote orchestrator, making this a no-op. */
  released: Schema.Boolean,
})

export const SteerPayload = Schema.Struct({
  sessionID: SessionID,
  agentID: Schema.String,
})

export const SteerResponse = Schema.Struct({
  /**
   * False when the Session has no open remote connection yet — i.e. it was bound to an
   * orchestrator but hasn't sent a first turn, or the last turn was interrupted. Steering is
   * advisory (see `SessionRunnerRemote.steerToAgent`), so this only reports frame delivery,
   * never whether the orchestrator actually handed off.
   */
  delivered: Schema.Boolean,
})

export class RemoteAgentServerNotFoundError extends Schema.ErrorClass<RemoteAgentServerNotFoundError>(
  "RemoteAgentServerNotFoundError",
)(
  {
    name: Schema.Literal("RemoteAgentServerNotFoundError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export const RemoteAgentPaths = {
  list: root,
  select: `${root}/select`,
  release: `${root}/release`,
  steer: `${root}/steer`,
} as const

export const RemoteAgentApi = HttpApi.make("remote-agent")
  .add(
    HttpApiGroup.make("remote-agent")
      .add(
        HttpApiEndpoint.get("list", RemoteAgentPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(ServerEntry), "Configured remote agent servers with live manifests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.remoteAgent.list",
            summary: "List remote agent servers",
            description:
              "List configured remote MAF agent bridge servers, each with its live-fetched agents manifest.",
          }),
        ),
        HttpApiEndpoint.post("select", RemoteAgentPaths.select, {
          query: WorkspaceRoutingQuery,
          payload: SelectPayload,
          success: described(SelectResponse, "Session bound to remote agent"),
          error: [RemoteAgentServerNotFoundError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.remoteAgent.select",
            summary: "Select remote agent",
            description: "Bind a session's Location to the selected remote orchestrator so its next turn runs there.",
          }),
        ),
        HttpApiEndpoint.post("release", RemoteAgentPaths.release, {
          query: WorkspaceRoutingQuery,
          payload: ReleasePayload,
          success: described(ReleaseResponse, "Session returned to its local Location"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.remoteAgent.release",
            summary: "Release remote agent",
            description:
              "Unbind a session from its remote orchestrator and return it to the local project, closing the remote connection. Ends the remote conversation: the MAF workflow lives for the lifetime of that connection and cannot be resumed.",
          }),
        ),
        HttpApiEndpoint.post("steer", RemoteAgentPaths.steer, {
          query: WorkspaceRoutingQuery,
          payload: SteerPayload,
          success: described(SteerResponse, "Steer frame delivery result"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.remoteAgent.steer",
            summary: "Steer remote agent",
            description:
              "Ask the session's remote orchestrator to hand the active turn off to a specific participant. Advisory: reports frame delivery only.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "remote-agent", description: "Experimental HttpApi remote agent routes." }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
