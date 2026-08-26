import { createMemo, createResource } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { errorMessage } from "../util/error"
import { parseRemoteWorkspaceID } from "../util/remote-agent"

/**
 * Picker for steering the active remote turn to a specific participant of the bound
 * orchestrator. Only reachable for sessions bound to a remote agent — app.tsx hides the
 * `/participants` command otherwise, so the guards below cover races (e.g. the binding
 * changing while the dialog is open) rather than the normal path.
 */
export function DialogParticipants() {
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()

  const binding = createMemo(() => {
    if (route.data.type !== "session") return undefined
    const session = sync.session.get(route.data.sessionID)
    const parsed = parseRemoteWorkspaceID(session?.workspaceID)
    if (!parsed) return undefined
    return { sessionID: route.data.sessionID, ...parsed }
  })

  const [remoteServers] = createResource(async () => {
    const result = await sdk.client.experimental.remoteAgent.list().catch(() => undefined)
    return result?.data ?? []
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const current = binding()
    if (!current) return []
    const orchestrator = (remoteServers() ?? [])
      .find((server) => server.id === current.serverID)
      ?.manifest?.orchestrators.find((entry) => entry.id === current.orchestratorID)

    return (orchestrator?.participants ?? []).map((participant) => ({
      value: participant.id,
      title: participant.name,
      description: participant.id,
      category: orchestrator?.name ?? "Participants",
    }))
  })

  return (
    <DialogSelect
      title="Steer to participant"
      options={options()}
      onSelect={async (option) => {
        const current = binding()
        if (!current) {
          toast.show({
            variant: "error",
            title: "No remote agent selected",
            message: "Pick a remote agent with /agents before steering to a participant.",
          })
          return
        }

        const result = await sdk.client.experimental.remoteAgent
          .steer({ sessionID: current.sessionID, agentID: option.value })
          .catch((err) => ({ data: undefined, error: err }))

        if (!result.data) {
          toast.show({
            variant: "error",
            title: "Failed to steer remote agent",
            message: errorMessage(result.error),
          })
          return
        }

        // Steering rides the Session's live turn socket, which only exists while a turn is in
        // flight. Say so explicitly rather than silently doing nothing — otherwise a steer sent
        // between turns looks identical to one the orchestrator simply declined.
        if (!result.data.delivered) {
          toast.show({
            variant: "warning",
            title: "Nothing to steer",
            message: "The remote agent has no turn in flight. Send a message first, then steer while it responds.",
          })
          return
        }

        toast.show({
          variant: "info",
          title: "Steering requested",
          message: `Asked the orchestrator to hand off to ${option.title}.`,
        })
        dialog.clear()
      }}
    />
  )
}
