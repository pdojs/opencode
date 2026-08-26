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
      participantID: undefined,
      solo: false,
    })
  })

  test("round-trips the optional participant segment addressing one agent in the network", () => {
    const workspaceID = SessionRunnerRemote.remoteWorkspaceID("bridge-1", "support", "refunds")
    expect(workspaceID).toBe("remote:bridge-1:support:refunds")
    expect(SessionRunnerRemote.parseRemoteWorkspaceID(workspaceID)).toEqual({
      serverID: "bridge-1",
      orchestratorID: "support",
      participantID: "refunds",
      solo: false,
    })
  })

  test("round-trips the solo segment marking a private conversation with one agent", () => {
    const workspaceID = SessionRunnerRemote.remoteWorkspaceID("bridge-1", "support", "refunds", true)
    expect(workspaceID).toBe("remote:bridge-1:support:refunds:solo")
    expect(SessionRunnerRemote.parseRemoteWorkspaceID(workspaceID)).toEqual({
      serverID: "bridge-1",
      orchestratorID: "support",
      participantID: "refunds",
      solo: true,
    })
  })

  test("returns undefined for a malformed remote workspace ID with no orchestrator segment", () => {
    expect(SessionRunnerRemote.parseRemoteWorkspaceID("remote:bridge-1")).toBeUndefined()
    expect(SessionRunnerRemote.parseRemoteWorkspaceID("remote:bridge-1:support:")).toBeUndefined()
    // A 4th segment is only meaningful as the solo marker.
    expect(SessionRunnerRemote.parseRemoteWorkspaceID("remote:bridge-1:support:a:b")).toBeUndefined()
    expect(SessionRunnerRemote.parseRemoteWorkspaceID("remote:bridge-1:support:a:solo:x")).toBeUndefined()
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
