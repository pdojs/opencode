import { describe, expect, test } from "bun:test"
import { RemoteProtocol } from "@opencode-ai/core/session/execution/remote-protocol"

describe("RemoteProtocol", () => {
  test("round-trips client frames through encode/decode", () => {
    const frame = RemoteProtocol.UserMessageFrame.make({ type: "user_message", text: "hello there" })
    const encoded = RemoteProtocol.encodeClientFrame(frame)
    expect(JSON.parse(encoded)).toEqual({ type: "user_message", text: "hello there" })
  })

  test("decodes a well-formed assistant_delta server frame", () => {
    const raw = JSON.stringify({ type: "assistant_delta", agent_id: "triage", text: "Hi!" })
    const decoded = RemoteProtocol.decodeServerFrame(raw)
    expect(decoded).toEqual({ type: "assistant_delta", agent_id: "triage", text: "Hi!" })
  })

  test("decodes a handoff server frame", () => {
    const raw = JSON.stringify({ type: "handoff", source: "triage", target: "billing" })
    const decoded = RemoteProtocol.decodeServerFrame(raw)
    expect(decoded).toEqual({ type: "handoff", source: "triage", target: "billing" })
  })

  test("decodes a tool_call server frame with an arguments record", () => {
    const raw = JSON.stringify({ type: "tool_call", call_id: "call_1", name: "bash", arguments: { command: "ls" } })
    const decoded = RemoteProtocol.decodeServerFrame(raw)
    expect(decoded).toEqual({ type: "tool_call", call_id: "call_1", name: "bash", arguments: { command: "ls" } })
  })

  test("returns undefined for malformed JSON", () => {
    expect(RemoteProtocol.decodeServerFrame("not json")).toBeUndefined()
  })

  test("returns undefined for an unrecognized frame type", () => {
    expect(RemoteProtocol.decodeServerFrame(JSON.stringify({ type: "unknown_type" }))).toBeUndefined()
  })

  test("decodes a manifest response body", () => {
    const decoded = RemoteProtocol.decodeManifest({
      orchestrators: [
        {
          id: "support",
          name: "Support handoff",
          description: "Triage/billing/refunds handoff group",
          participants: [{ id: "triage", name: "Triage" }],
        },
      ],
    })
    expect(decoded?.orchestrators).toHaveLength(1)
    expect(decoded?.orchestrators[0]?.id).toBe("support")
  })

  test("returns undefined for a malformed manifest", () => {
    expect(RemoteProtocol.decodeManifest({ orchestrators: "not-an-array" })).toBeUndefined()
  })
})
