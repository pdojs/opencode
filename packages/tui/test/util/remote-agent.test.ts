import { describe, expect, test } from "bun:test"
import { parseRemoteWorkspaceID } from "../../src/util/remote-agent"

describe("util.remoteAgent", () => {
  test("parses a remote sentinel workspace ID", () => {
    expect(parseRemoteWorkspaceID("remote:demo-bridge:support")).toEqual({
      serverID: "demo-bridge",
      orchestratorID: "support",
      participantID: undefined,
      solo: false,
    })
  })

  test("parses the optional participant segment addressing one agent in the network", () => {
    expect(parseRemoteWorkspaceID("remote:demo-bridge:support:refunds")).toEqual({
      serverID: "demo-bridge",
      orchestratorID: "support",
      participantID: "refunds",
      solo: false,
    })
  })

  test("parses the solo segment marking a private conversation with one agent", () => {
    expect(parseRemoteWorkspaceID("remote:demo-bridge:support:refunds:solo")).toEqual({
      serverID: "demo-bridge",
      orchestratorID: "support",
      participantID: "refunds",
      solo: true,
    })
  })

  test("ignores real and missing workspace IDs", () => {
    expect(parseRemoteWorkspaceID("wrk_01234567")).toBeUndefined()
    expect(parseRemoteWorkspaceID(undefined)).toBeUndefined()
    // Malformed sentinels must not parse either, so callers fall back to normal workspace
    // handling rather than treating a broken value as a remote binding.
    expect(parseRemoteWorkspaceID("remote:demo-bridge")).toBeUndefined()
    expect(parseRemoteWorkspaceID("remote::support")).toBeUndefined()
    expect(parseRemoteWorkspaceID("remote:demo-bridge:support:")).toBeUndefined()
    // A 4th segment is only meaningful as the solo marker.
    expect(parseRemoteWorkspaceID("remote:demo-bridge:support:refunds:extra")).toBeUndefined()
    expect(parseRemoteWorkspaceID("remote:demo-bridge:support:refunds:solo:extra")).toBeUndefined()
  })

  /**
   * Guards the bug where sending the first message to a remote-bound session opened the
   * "Workspace Unavailable" restore dialog: remote sentinels are deliberately absent from the
   * workspace registry, so `project.workspace.status()` returns undefined for them. The restore
   * flow's "use the local project" branch warps the session to workspaceID null, which silently
   * undid the remote agent selection and reverted the status bar to the local agent.
   */
  test("recognizes a sentinel so it is never mistaken for an unavailable workspace", () => {
    // Mirrors the gate in component/prompt/index.tsx's submitInner.
    const promptsRestore = (workspaceID: string, status: string | undefined) =>
      !parseRemoteWorkspaceID(workspaceID) && (status ?? "error") !== "connected"

    // A sentinel has no registry entry, so status() misses — but it must not prompt.
    expect(promptsRestore("remote:demo-bridge:support", undefined)).toBeFalse()
    // A genuinely dangling workspace must still reach the restore dialog.
    expect(promptsRestore("wrk_dangling", undefined)).toBeTrue()
    // A healthy workspace passes through untouched.
    expect(promptsRestore("wrk_healthy", "connected")).toBeFalse()
  })
})
