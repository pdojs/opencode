export * as RemoteProtocol from "./remote-protocol"

import { Option, Schema } from "effect"

/**
 * TypeScript mirror of the wire protocol implemented by the MAF handoff bridge server at
 * `test/remote-maf-handoff-agents/app/protocol.py`. This file is manually kept in sync with
 * that Python module — there is no codegen (deferred per design-proposal.md's Deferred
 * section). Update both sides together whenever a frame shape changes.
 */

// region client -> server frames

export class UserMessageFrame extends Schema.Class<UserMessageFrame>("RemoteProtocol.UserMessageFrame")({
  type: Schema.Literal("user_message"),
  text: Schema.String,
}) {}

export class ToolResultFrame extends Schema.Class<ToolResultFrame>("RemoteProtocol.ToolResultFrame")({
  type: Schema.Literal("tool_result"),
  call_id: Schema.String,
  output: Schema.String,
}) {}

export class SteerToAgentFrame extends Schema.Class<SteerToAgentFrame>("RemoteProtocol.SteerToAgentFrame")({
  type: Schema.Literal("steer_to_agent"),
  agent_id: Schema.String,
}) {}

export const ClientFrame = Schema.Union([UserMessageFrame, ToolResultFrame, SteerToAgentFrame])
export type ClientFrame = typeof ClientFrame.Type

// endregion

// region server -> client frames

export class AssistantDeltaFrame extends Schema.Class<AssistantDeltaFrame>("RemoteProtocol.AssistantDeltaFrame")({
  type: Schema.Literal("assistant_delta"),
  agent_id: Schema.String,
  text: Schema.String,
}) {}

export class HandoffFrame extends Schema.Class<HandoffFrame>("RemoteProtocol.HandoffFrame")({
  type: Schema.Literal("handoff"),
  source: Schema.String,
  target: Schema.String,
}) {}

export class ToolCallFrame extends Schema.Class<ToolCallFrame>("RemoteProtocol.ToolCallFrame")({
  type: Schema.Literal("tool_call"),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
}) {}

export class TurnCompleteFrame extends Schema.Class<TurnCompleteFrame>("RemoteProtocol.TurnCompleteFrame")({
  type: Schema.Literal("turn_complete"),
}) {}

export class ErrorFrame extends Schema.Class<ErrorFrame>("RemoteProtocol.ErrorFrame")({
  type: Schema.Literal("error"),
  message: Schema.String,
}) {}

export const ServerFrame = Schema.Union([
  AssistantDeltaFrame,
  HandoffFrame,
  ToolCallFrame,
  TurnCompleteFrame,
  ErrorFrame,
])
export type ServerFrame = typeof ServerFrame.Type

// endregion

export class Participant extends Schema.Class<Participant>("RemoteProtocol.Participant")({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
}) {}

export class OrchestratorManifestEntry extends Schema.Class<OrchestratorManifestEntry>(
  "RemoteProtocol.OrchestratorManifestEntry",
)({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  participants: Schema.Array(Participant),
  /**
   * Capability fields mirroring `OrchestratorManifestEntry` in the bridge's `app/protocol.py`.
   * Optional so an older bridge still parses; consumers fall back to handoff semantics, which
   * is what every orchestrator shipped before these fields existed.
   */
  pattern: Schema.optional(Schema.String),
  /**
   * How much of the conversation each participant sees. `shared` (handoff, group chat) means
   * every participant observes the whole conversation; `scoped` (sequential) means each sees
   * only what the previous one passed down; `isolated` (concurrent) means each sees only the
   * original user input.
   */
  context_scope: Schema.optional(Schema.Union([Schema.Literal("shared"), Schema.Literal("scoped"), Schema.Literal("isolated")])),
  /** False for single-shot patterns, where turn 2 has no memory of turn 1. */
  multi_turn: Schema.optional(Schema.Boolean),
  /** False when the pattern has no notion of a start agent, so participants cannot be targeted. */
  addressable: Schema.optional(Schema.Boolean),
}) {}

export class Manifest extends Schema.Class<Manifest>("RemoteProtocol.Manifest")({
  orchestrators: Schema.Array(OrchestratorManifestEntry),
}) {}

const decodeServerFrameJSON = Schema.decodeUnknownOption(ServerFrame)
const encodeClientFrameJSON = Schema.encodeSync(ClientFrame)
const decodeManifestJSON = Schema.decodeUnknownOption(Manifest)

/** Parses raw WS text into a ServerFrame, returning undefined on malformed JSON or an unrecognized shape. */
export const decodeServerFrame = (raw: string): ServerFrame | undefined => {
  try {
    return Option.getOrUndefined(decodeServerFrameJSON(JSON.parse(raw)))
  } catch {
    return undefined
  }
}

/** Serializes a ClientFrame to the JSON text sent over the WS connection. */
export const encodeClientFrame = (frame: ClientFrame) => JSON.stringify(encodeClientFrameJSON(frame))

/** Parses the `GET /agents/manifest` JSON response body, returning undefined if malformed. */
export const decodeManifest = (raw: unknown): Manifest | undefined => Option.getOrUndefined(decodeManifestJSON(raw))
