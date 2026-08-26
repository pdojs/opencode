import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionRunnerRemote } from "@opencode-ai/core/session/runner/remote"

describe("SessionRunnerRemote workspace ID encoding", () => {
  test("recognizes a remote-prefixed workspace ID", () => {
    expect(SessionRunnerRemote.isRemoteWorkspaceID("remote:bridge-1:support")).toBe(true)
  })

  test("does not recognize a local workspace ID", () => {
    expect(SessionRunnerRemote.isRemoteWorkspaceID(undefined)).toBe(false)
    expect(SessionRunnerRemote.isRemoteWorkspaceID("local-workspace")).toBe(false)
  })

  test("round-trips serverID/orchestratorID through remoteWorkspaceID/parseRemoteWorkspaceID", () => {
    const workspaceID = SessionRunnerRemote.remoteWorkspaceID("bridge-1", "support")
    expect(workspaceID).toBe("remote:bridge-1:support")
    expect(SessionRunnerRemote.parseRemoteWorkspaceID(workspaceID)).toEqual({
      serverID: "bridge-1",
      orchestratorID: "support",
    })
  })

  test("returns undefined for a malformed remote workspace ID with no orchestrator segment", () => {
    expect(SessionRunnerRemote.parseRemoteWorkspaceID("remote:bridge-1")).toBeUndefined()
  })
})

describe("SessionRunnerRemote.steerToAgent", () => {
  test("no-ops and returns false when the Session has no open remote connection", () => {
    const result = Effect.runSync(
      SessionRunnerRemote.steerToAgent("ses_nonexistent" as never, "support"),
    )
    expect(result).toBe(false)
  })
})
