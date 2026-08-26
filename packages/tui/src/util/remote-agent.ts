// Mirrors the `remote:<serverID>:<orchestratorID>` sentinel Location.workspaceID convention
// defined server-side by SessionRunnerRemote (packages/core/src/session/runner/remote.ts).
// Reimplemented here (rather than imported) since that module pulls in server-only deps
// (Database, ToolRegistry, etc.) unsuitable for the browser-safe TUI client bundle — this is
// just a plain string parse of a value already exposed to any client via the session API.
const WORKSPACE_ID_PREFIX = "remote:"

export function parseRemoteWorkspaceID(workspaceID: string | undefined) {
  if (!workspaceID || !workspaceID.startsWith(WORKSPACE_ID_PREFIX)) return undefined
  const [, serverID, orchestratorID] = workspaceID.split(":")
  if (!serverID || !orchestratorID) return undefined
  return { serverID, orchestratorID }
}
