export * as LLMRemoteStream from "./remote-stream";

import { LLMEvent } from "@opencode-ai/llm";
import { RemoteProtocol } from "@opencode-ai/core/session/execution/remote-protocol";
import { RemoteToolBridge } from "@opencode-ai/core/session/runner/remote-tool-bridge";
import { SessionRunnerRemote } from "@opencode-ai/core/session/runner/remote";
import { SessionSchema } from "@opencode-ai/core/session/schema";
import { Cause, Effect, Queue, Stream } from "effect";
import type { Tool } from "ai";

export type Target = {
  readonly serverID: string;
  readonly orchestratorID: string;
};

/**
 * Renders one remote MAF turn as the same `LLMEvent` stream the local provider runtimes emit,
 * so the existing V1 processor persists it as ordinary message parts and the TUI renders a
 * remote session identically to a local one.
 *
 * Handoffs have no `LLMEvent` equivalent, so they are surfaced as an inline text segment —
 * matching how SessionRunnerRemote presents them on the V2 path.
 */
export const stream = (input: {
  readonly sessionID: string;
  readonly target: Target;
  readonly text: string;
  readonly tools: Record<string, Tool>;
  readonly baseURL: string;
}): Stream.Stream<LLMEvent, Error> =>
  Stream.callback<LLMEvent, Error>((queue) =>
    Effect.gen(function* () {
      const connection = yield* SessionRunnerRemote.openConnection(
        SessionSchema.ID.make(input.sessionID),
        input.target.orchestratorID,
        input.baseURL,
      ).pipe(Effect.mapError((error) => new Error(error.message)));

      connection.send(
        RemoteProtocol.UserMessageFrame.make({
          type: "user_message",
          text: input.text,
        }),
      );

      yield* relay(input.sessionID, connection, queue, input.tools).pipe(
        Effect.forkScoped,
      );
    }),
  );

/** Pumps bridge frames into `queue` as LLMEvents until the turn ends, the socket closes, or it errors. */
const relay = Effect.fnUntraced(function* (
  sessionID: string,
  connection: SessionRunnerRemote.Connection,
  queue: Queue.Queue<LLMEvent, Error | Cause.Done>,
  tools: Record<string, Tool>,
) {
  let blockID = 0;
  let activeAgent: string | undefined;

  const offer = (...events: LLMEvent[]) => Queue.offerAll(queue, events);
  const closeText = () =>
    activeAgent === undefined
      ? []
      : [LLMEvent.textEnd({ id: String(blockID) })];
  const openText = (agent: string | undefined) => {
    activeAgent = agent;
    blockID += 1;
    return [LLMEvent.textStart({ id: String(blockID) })];
  };
  // Always "stop": the bridge runs the remote agent's tool calls inline and only settles once the
  // orchestrator reports `turn_complete`, so there is never a pending call for the V1 loop to
  // resume — reporting "tool-calls" here would make it re-prompt the orchestrator in a loop.
  const settle = Effect.fnUntraced(function* () {
    yield* offer(
      ...closeText(),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    );
    yield* Queue.end(queue);
  });

  yield* offer(LLMEvent.stepStart({ index: 0 }));

  while (true) {
    const frame = yield* connection.next();
    if (!frame) {
      yield* SessionRunnerRemote.closeConnection(
        SessionSchema.ID.make(sessionID),
        "connection closed mid-turn",
      );
      return yield* settle();
    }
    switch (frame.type) {
      case "assistant_delta": {
        if (activeAgent !== frame.agent_id)
          yield* offer(...closeText(), ...openText(frame.agent_id));
        yield* offer(
          LLMEvent.textDelta({ id: String(blockID), text: frame.text }),
        );
        break;
      }
      case "handoff": {
        yield* offer(
          ...closeText(),
          ...openText(undefined),
          LLMEvent.textDelta({
            id: String(blockID),
            text: `↪ handoff: ${frame.source} → ${frame.target}`,
          }),
          LLMEvent.textEnd({ id: String(blockID) }),
        );
        activeAgent = undefined;
        break;
      }
      case "tool_call": {
        // The remote agent blocks on `tool_result`, and the V1 loop only runs tools the provider
        // itself invoked, so the bridge executes the mapped local tool inline here — through the
        // very same permission-gated `SessionTools` definition a local turn would have used —
        // and answers the socket before resuming frame consumption.
        yield* offer(
          ...closeText(),
          LLMEvent.toolInputStart({ id: frame.call_id, name: frame.name }),
          LLMEvent.toolInputEnd({ id: frame.call_id, name: frame.name }),
        );
        activeAgent = undefined;

        const local = RemoteToolBridge.localName(frame.name);
        const definition = local ? tools[local] : undefined;
        if (!local || !definition?.execute) {
          const message = `Unsupported remote tool call: ${frame.name}`;
          connection.send(
            RemoteProtocol.ToolResultFrame.make({
              type: "tool_result",
              call_id: frame.call_id,
              output: message,
            }),
          );
          yield* offer(
            LLMEvent.toolCall({
              id: frame.call_id,
              name: frame.name,
              input: frame.arguments,
              providerExecuted: true,
            }),
            LLMEvent.toolError({
              id: frame.call_id,
              name: frame.name,
              message,
            }),
            LLMEvent.toolResult({
              id: frame.call_id,
              name: frame.name,
              result: { type: "error", value: message },
              providerExecuted: true,
            }),
          );
          break;
        }

        const args = RemoteToolBridge.translateInput(local, frame.arguments);
        // `providerExecuted` marks the call as settled outside the V1 model loop. Without it,
        // `SessionPrompt`'s loop-exit check (prompt.ts:1108) treats the tool part as still owed a
        // result and re-prompts the orchestrator until it hits the step cap.
        yield* offer(
          LLMEvent.toolCall({
            id: frame.call_id,
            name: local,
            input: args,
            providerExecuted: true,
          }),
        );
        const settled = yield* Effect.promise(async () => {
          try {
            return {
              value: await definition.execute!(args, {
                toolCallId: frame.call_id,
                messages: [],
              }),
            };
          } catch (error) {
            return {
              failure: error instanceof Error ? error.message : String(error),
            };
          }
        });

        if ("failure" in settled) {
          connection.send(
            RemoteProtocol.ToolResultFrame.make({
              type: "tool_result",
              call_id: frame.call_id,
              output: settled.failure!,
            }),
          );
          yield* offer(
            LLMEvent.toolError({
              id: frame.call_id,
              name: local,
              message: settled.failure!,
            }),
            LLMEvent.toolResult({
              id: frame.call_id,
              name: local,
              result: { type: "error", value: settled.failure! },
              providerExecuted: true,
            }),
          );
          break;
        }

        connection.send(
          RemoteProtocol.ToolResultFrame.make({
            type: "tool_result",
            call_id: frame.call_id,
            output: toolResultText(settled.value),
          }),
        );
        yield* offer(
          LLMEvent.toolResult({
            id: frame.call_id,
            name: local,
            result: { type: "json", value: settled.value },
            providerExecuted: true,
          }),
        );
        break;
      }
      case "turn_complete":
        return yield* settle();
      case "error":
        return yield* Queue.fail(queue, new Error(frame.message));
    }
  }
});

function toolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const value = output as { value?: unknown };
    if (typeof value.value === "string") return value.value;
  }
  return JSON.stringify(output) ?? "";
}
