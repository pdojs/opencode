import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { errorMessage } from "../util/error"
import { parseRemoteWorkspaceID } from "../util/remote-agent"
import { Locale } from "../util/locale"

/**
 * Offered when picking a remote agent that already holds conversations, so the user rejoins one
 * rather than silently starting over. The agent-side conversation is restored from a checkpoint
 * keyed by the session id, so reusing a session resumes both halves.
 */
export function DialogRemoteSession(props: {
  serverID: string
  orchestratorID: string
  participantID?: string
  solo?: boolean
  name: string
}) {
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()

  const options = createMemo<DialogSelectOption<string | undefined>[]>(() => {
    const prior = sync.session
      .list()
      .filter((session) => {
        const remote = parseRemoteWorkspaceID(session.workspaceID)
        if (remote?.serverID !== props.serverID || remote.orchestratorID !== props.orchestratorID) return false
        // A private conversation with one agent and the shared network conversation are separate
        // transcripts, so they must not be offered as if they were interchangeable.
        if (remote.solo !== (props.solo ?? false)) return false
        return !remote.solo || remote.participantID === props.participantID
      })
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((session) => ({
        value: session.id,
        title: session.title || "Untitled",
        description: Locale.todayTimeOrDateTime(session.time.updated),
        category: "Rejoin",
      }))
    return [{ value: undefined, title: "New session", category: "Start" }, ...prior]
  })

  return (
    <DialogSelect
      title={`Sessions with ${props.name}`}
      options={options()}
      onSelect={async (option) => {
        let sessionID = option.value
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
        }
        route.navigate({ type: "session", sessionID })

        const result = await sdk.client.experimental.remoteAgent
          .select({
            sessionID,
            serverID: props.serverID,
            orchestratorID: props.orchestratorID,
            participantID: props.participantID,
            solo: props.solo,
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
