import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ServerWebSocket } from "bun"
import { SessionRunnerRemote } from "../src/session/runner/remote"
import { SessionSchema } from "../src/session/schema"

/**
 * Stands in for the MAF bridge, recording the text of every user turn it receives and how many
 * distinct sockets were opened. A real WebSocket rather than a mock, so `openConnection`'s
 * actual reuse/reconnect decision is what gets exercised.
 */
const turns: string[] = []
let opened = 0
const server = Bun.serve({
  port: 0,
  fetch: (request, self) => {
    if (!self.upgrade(request)) return new Response("expected websocket", { status: 400 })
    opened += 1
    return undefined
  },
  websocket: {
    message: (_socket: ServerWebSocket<unknown>, message) => {
      const frame = JSON.parse(String(message))
      if (frame.type === "user_message") turns.push(frame.text)
    },
    open: () => {},
  },
})
const baseURL = `http://localhost:${server.port}`

afterAll(() => server.stop(true))

describe("SessionRunnerRemote.openConnection participant switching", () => {
  /**
   * The MAF workflow — and with it the entire conversation every participant in a handoff
   * network can see — lives for exactly as long as this socket. Reconnecting to change the
   * start agent would silently discard it, so switching participant has to redirect the
   * running conversation instead.
   */
  test("reuses the live workflow and redirects the next turn when only the participant changes", async () => {
    const sessionID = SessionSchema.ID.make("ses_switch0000000000000000")

    const first = await Effect.runPromise(SessionRunnerRemote.openConnection(sessionID, "support", baseURL))
    first.sendUserTurn("I have a billing question")

    const second = await Effect.runPromise(
      SessionRunnerRemote.openConnection(sessionID, "support", baseURL, "refunds"),
    )
    expect(second).toBe(first)
    second.sendUserTurn("actually I want a refund")
    // The redirect applies to exactly one turn and must not leak into later ones.
    second.sendUserTurn("how long does it take?")

    await Bun.sleep(50)
    expect(opened).toBe(1)
    expect(turns[0]).toBe("I have a billing question")
    expect(turns[1]).toContain("refunds")
    expect(turns[1]).toContain("actually I want a refund")
    expect(turns[2]).toBe("how long does it take?")

    await Effect.runPromise(SessionRunnerRemote.closeConnection(sessionID, "test over"))
  })

  test("opens a new workflow when the orchestrator itself changes", async () => {
    const sessionID = SessionSchema.ID.make("ses_switch1111111111111111")
    opened = 0

    const first = await Effect.runPromise(SessionRunnerRemote.openConnection(sessionID, "support", baseURL))
    // A different orchestrator is a genuinely different workflow with nothing to carry over.
    const second = await Effect.runPromise(SessionRunnerRemote.openConnection(sessionID, "research", baseURL))

    expect(second).not.toBe(first)
    expect(opened).toBe(2)

    await Effect.runPromise(SessionRunnerRemote.closeConnection(sessionID, "test over"))
  })
})
