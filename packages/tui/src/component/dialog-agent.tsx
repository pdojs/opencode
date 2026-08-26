import { createMemo, createResource } from "solid-js"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { errorMessage } from "../util/error"
import { parseRemoteWorkspaceID } from "../util/remote-agent"

type AgentOption =
  | { type: "local"; name: string }
  | { type: "remote"; serverID: string; orchestratorID: string; participantID?: string; name: string }

export function DialogAgent() {
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()

  const [remoteServers] = createResource(async () => {
    const result = await sdk.client.experimental.remoteAgent.list().catch(() => undefined)
    return result?.data ?? []
  })

  const options = createMemo<DialogSelectOption<AgentOption>[]>(() => {
    const local_ = local.agent.list().map((item) => ({
      value: { type: "local", name: item.name } as AgentOption,
      title: item.name,
      description: item.native ? "native" : item.description,
      category: item.native ? "Native" : "Workspace",
    }))

    // Every agent in the network is individually addressable: the orchestrator entry enters at
    // its default start agent, and each participant entry starts the conversation at that agent.
    // Handoffs still apply from wherever the conversation begins.
    const remote = (remoteServers() ?? []).flatMap((server) =>
      (server.manifest?.orchestrators ?? []).flatMap((orchestrator) => [
        {
          value: {
            type: "remote",
            serverID: server.id,
            orchestratorID: orchestrator.id,
            name: orchestrator.name,
          } as AgentOption,
          title: orchestrator.name,
          description: orchestrator.description || `remote · ${server.id}`,
          category: `Remote · ${orchestrator.name}`,
        },
        ...(orchestrator.participants ?? []).map((participant) => ({
          value: {
            type: "remote",
            serverID: server.id,
            orchestratorID: orchestrator.id,
            participantID: participant.id,
            name: participant.name,
          } as AgentOption,
          title: participant.name,
          description: participant.description || `remote · ${orchestrator.name}`,
          category: `Remote · ${orchestrator.name}`,
        })),
      ]),
    )

    return [...local_, ...remote]
  })

  // Reflects the active session's remote binding (if any) so the dialog highlights the
  // currently-selected remote orchestrator the same way it highlights a local agent. Looked up
  // against `options()` (not synthesized directly) so it deep-equals the matching option's
  // value exactly, including `name` — required for DialogSelect's isDeepEqual highlight check.
  const currentRemote = createMemo(() => {
    if (route.data.type !== "session") return undefined
    const session = sync.session.get(route.data.sessionID)
    const parsed = parseRemoteWorkspaceID(session?.workspaceID)
    if (!parsed) return undefined
    return options().find(
      (opt) =>
        opt.value.type === "remote" &&
        opt.value.serverID === parsed.serverID &&
        opt.value.orchestratorID === parsed.orchestratorID &&
        opt.value.participantID === parsed.participantID,
    )?.value
  })

  return (
    <DialogSelect
      title="Select agent"
      current={
        currentRemote() ??
        (local.agent.current()?.name
          ? ({ type: "local", name: local.agent.current()!.name } as AgentOption)
          : undefined)
      }
      options={options()}
      onSelect={async (option) => {
        if (option.value.type === "local") {
          local.agent.set(option.value.name)
          dialog.clear()
          return
        }

        // Remote agents bind to a Session (their handoff state lives server-side, keyed by
        // sessionID), but the user should be able to pick one before ever sending a message —
        // transparently create an empty session here instead of requiring one to pre-exist.
        let sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        if (!sessionID) {
          const created = await sdk.client.session
            .create({ directory: sdk.directory })
            .catch((err) => ({ data: undefined, error: err }))
          if (!created.data) {
            toast.show({
              variant: "error",
              title: "Failed to start session",
              message: errorMessage(created.error),
            })
            return
          }
          sessionID = created.data.id
          route.navigate({ type: "session", sessionID })
        }

        const result = await sdk.client.experimental.remoteAgent
          .select({
            sessionID,
            serverID: option.value.serverID,
            orchestratorID: option.value.orchestratorID,
            participantID: option.value.participantID,
          })
          .catch((err) => ({ data: undefined, error: err }))

        if (!result.data) {
          toast.show({
            variant: "error",
            title: "Failed to select remote agent",
            message: errorMessage(result.error),
          })
          return
        }

        dialog.clear()
      }}
    />
  )
}
