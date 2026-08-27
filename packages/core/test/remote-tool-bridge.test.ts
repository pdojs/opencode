import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { RemoteToolBridge } from "@opencode-ai/core/session/runner/remote-tool-bridge"
import type { ToolRegistry } from "@opencode-ai/core/tool/registry"

const fakeRegistry = (settle: ToolRegistry.Materialization["settle"]): ToolRegistry.Interface => ({
  register: () => Effect.void,
  materialize: () => Effect.succeed({ definitions: [], settle }),
})

const baseInput = {
  sessionID: "ses_test" as SessionSchema.ID,
  agent: AgentV2.ID.make("support"),
  assistantMessageID: "msg_test" as SessionMessage.ID,
  callID: "call_1",
}

describe("RemoteToolBridge.execute", () => {
  test("rejects an unmapped remote tool name without calling the registry", async () => {
    let called = false
    const registry = fakeRegistry(() => {
      called = true
      return Effect.succeed({ result: { type: "json" as const, value: {} } })
    })
    const settlement = await Effect.runPromise(
      RemoteToolBridge.execute({ ...baseInput, registry, name: "delete_everything", arguments: {} }),
    )
    expect(called).toBe(false)
    expect(settlement.result).toEqual({ type: "error", value: "Unsupported remote tool call: delete_everything" })
  })

  test("maps run_local_command to the local bash tool with a translated input", async () => {
    let received: unknown
    const registry = fakeRegistry((input) => {
      received = input.call
      return Effect.succeed({ result: { type: "text" as const, value: "ok" } })
    })
    const settlement = await Effect.runPromise(
      RemoteToolBridge.execute({
        ...baseInput,
        registry,
        name: "run_local_command",
        arguments: { command: "ls -la" },
      }),
    )
    expect(received).toEqual({ type: "tool-call", id: "call_1", name: "bash", input: { command: "ls -la" } })
    expect(settlement.result).toEqual({ type: "text", value: "ok" })
  })
})

describe("RemoteToolBridge.resultText", () => {
  test("passes through a text result value as-is", () => {
    expect(RemoteToolBridge.resultText({ type: "text", value: "hello" })).toBe("hello")
  })

  test("JSON-stringifies a non-string result value", () => {
    expect(RemoteToolBridge.resultText({ type: "json", value: { exit: 0 } })).toBe('{"exit":0}')
  })
})
