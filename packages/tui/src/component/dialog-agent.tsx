import { createMemo, createResource } from "solid-js"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { errorMessage } from "../util/error"

type AgentOption =
  | { type: "local"; name: string }
  | { type: "remote"; serverID: string; orchestratorID: string; name: string }

export function DialogAgent() {
  const local = useLocal()
  const sdk = useSDK()
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

    const remote = (remoteServers() ?? []).flatMap((server) =>
      (server.manifest?.orchestrators ?? []).map((orchestrator) => ({
        value: {
          type: "remote",
          serverID: server.id,
          orchestratorID: orchestrator.id,
          name: orchestrator.name,
        } as AgentOption,
        title: orchestrator.name,
        description: orchestrator.description || `remote · ${server.id}`,
        category: "Remote",
      })),
    )

    return [...local_, ...remote]
  })

  return (
    <DialogSelect
      title="Select agent"
      current={
        local.agent.current()?.name
          ? ({ type: "local", name: local.agent.current()!.name } as AgentOption)
          : undefined
      }
      options={options()}
      onSelect={async (option) => {
        if (option.value.type === "local") {
          local.agent.set(option.value.name)
          dialog.clear()
          return
        }

        if (route.data.type !== "session") {
          toast.show({
            variant: "warning",
            message: "Start a session before selecting a remote agent",
            duration: 3000,
          })
          return
        }

        const result = await sdk.client.experimental.remoteAgent
          .select({
            sessionID: route.data.sessionID,
            serverID: option.value.serverID,
            orchestratorID: option.value.orchestratorID,
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
