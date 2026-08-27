export * as RemoteToolBridge from "./remote-tool-bridge"

import { Effect } from "effect"
import type { ToolResultValue } from "@opencode-ai/llm"
import { AgentV2 } from "../../agent"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { ToolRegistry } from "../../tool/registry"

/**
 * Maps a remote MAF orchestrator's declared tool name (e.g. `run_local_command`, from
 * `remote-maf-handoff-agents/app/orchestrator.py`) to one of OpenCode's local canonical
 * `Tool.make`-registered names (`packages/core/src/tool/*`), and translates the remote tool's
 * argument shape into that local tool's input shape. Unmapped names are rejected below rather
 * than silently ignored or forwarded — a remote agent must not be able to invoke arbitrary local
 * tool names the bridge hasn't explicitly vetted.
 */
const NAME_MAP: Readonly<Record<string, string>> = {
  run_local_command: "bash",
}

/** Resolves a remote tool name to its vetted local equivalent, or undefined if unmapped. */
export const localName = (remoteName: string): string | undefined => NAME_MAP[remoteName]

export const translateInput = (localName: string, remoteArguments: Readonly<Record<string, unknown>>): unknown => {
  switch (localName) {
    case "bash":
      return { command: remoteArguments.command }
    default:
      return remoteArguments
  }
}

/** Renders a `ToolResultValue` into the plain-text `output` field the `tool_result` wire frame expects. */
export const resultText = (result: ToolResultValue): string => {
  if (typeof result.value === "string") return result.value
  try {
    return JSON.stringify(result.value) ?? String(result.value)
  } catch {
    return String(result.value)
  }
}

/**
 * Executes one remote `tool_call` frame's request against OpenCode's existing Location-scoped
 * `ToolRegistry.Service` — the same registry, permission gating (`PermissionV2.Service`, wired
 * inside each built-in tool's own layer), and execution path a local agent's tool calls go
 * through. Returns the settlement so the caller can publish the same `SessionEvent.Tool.*`
 * events a local tool call would produce; never throws for an unmapped name — that's reported as
 * an ordinary error `ToolResultValue` so the remote turn is never left hanging.
 */
export const execute = Effect.fn("RemoteToolBridge.execute")(function* (input: {
  readonly registry: ToolRegistry.Interface
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}) {
  const local = NAME_MAP[input.name]
  if (!local)
    return { result: { type: "error" as const, value: `Unsupported remote tool call: ${input.name}` } }

  const materialization = yield* input.registry.materialize()
  return yield* materialization.settle({
    sessionID: input.sessionID,
    agent: input.agent,
    assistantMessageID: input.assistantMessageID,
    call: {
      type: "tool-call",
      id: input.callID,
      name: local,
      input: translateInput(local, input.arguments),
    },
  })
})

