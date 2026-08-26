import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { ServerWebSocket } from "bun";
import type { Tool } from "ai";
import { LLMRemoteStream } from "@/session/llm/remote-stream";
import { SessionRunnerRemote } from "@opencode-ai/core/session/runner/remote";
import { SessionSchema } from "@opencode-ai/core/session/schema";

/**
 * A stand-in for the MAF bridge (`test/remote-maf-handoff-agents/app/server.py`) speaking the
 * real wire protocol over a real WebSocket, so the translation under test is exercised end to
 * end rather than against a mocked connection.
 */
const received: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: (request, self) =>
    self.upgrade(request)
      ? undefined
      : new Response("expected websocket", { status: 400 }),
  websocket: {
    message: (socket: ServerWebSocket<unknown>, message) => {
      const frame = JSON.parse(String(message));
      received.push(frame.type);
      if (frame.type === "user_message") {
        socket.send(
          JSON.stringify({
            type: "assistant_delta",
            agent_id: "triage",
            text: "Let me check.",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "handoff",
            source: "triage",
            target: "billing",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "tool_call",
            call_id: "call-1",
            name: "run_local_command",
            arguments: { command: "echo hi" },
          }),
        );
        return;
      }
      if (frame.type === "tool_result") {
        socket.send(
          JSON.stringify({
            type: "assistant_delta",
            agent_id: "billing",
            text: `saw ${frame.output}`,
          }),
        );
        socket.send(JSON.stringify({ type: "turn_complete" }));
      }
    },
  },
});

afterAll(() => server.stop(true));

const bash = {
  execute: async () => ({ output: "hi", title: "echo hi", metadata: {} }),
} as unknown as Tool;

const run = (sessionID: string, tools: Record<string, Tool>) =>
  Effect.runPromise(
    LLMRemoteStream.stream({
      sessionID,
      target: { serverID: "stub", orchestratorID: "support" },
      text: "hello",
      tools,
      baseURL: `http://127.0.0.1:${server.port}`,
    }).pipe(
      Stream.runCollect,
      Effect.map((events) => events.map((event) => event.type)),
      Effect.ensuring(
        SessionRunnerRemote.closeConnection(
          SessionSchema.ID.make(sessionID),
          "test complete",
        ),
      ),
    ),
  );

describe("LLMRemoteStream.stream", () => {
  test("translates bridge frames into a single V1 provider turn and answers tool calls inline", async () => {
    const events = await run("ses_remote_stream_happy", { bash });

    expect(events.filter((type) => type === "step-start")).toHaveLength(1);
    // Exactly one step-finish, always reason "stop", so SessionPrompt's loop does not re-prompt.
    expect(events.filter((type) => type === "step-finish")).toHaveLength(1);
    expect(events).toContain("text-delta");
    expect(events).toContain("tool-call");
    expect(events).toContain("tool-result");
    expect(events).not.toContain("tool-error");
    // The turn only settles after the tool result was sent back and the agent replied.
    expect(received).toEqual(["user_message", "tool_result"]);
  });

  test("answers an unmapped remote tool name with an error instead of invoking a local tool", async () => {
    received.length = 0;
    const events = await run("ses_remote_stream_unmapped", {});

    expect(events).toContain("tool-error");
    expect(events).toContain("tool-result");
    expect(received).toEqual(["user_message", "tool_result"]);
  });
});
