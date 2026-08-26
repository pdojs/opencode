import { createMemo, For, Show } from "solid-js"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { parseRemoteWorkspaceID } from "../../util/remote-agent"

/**
 * Lists the other conversations this session's remote agent already holds, so a session can be
 * left and rejoined later rather than being lost when its socket closes.
 *
 * A remote session's durable transcript lives here as an ordinary session; the agent-side half is
 * resumed from a checkpoint keyed by the same session id (see test/remote-maf-handoff-agents).
 * Picking an entry therefore restores both sides.
 */
export function SidebarRemoteSessions(props: { sessionID: string }) {
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()

  const current = createMemo(() => parseRemoteWorkspaceID(sync.session.get(props.sessionID)?.workspaceID))

  const siblings = createMemo(() => {
    const agent = current()
    if (!agent) return []
    return sync.session
      .list()
      .filter((session) => {
        const remote = parseRemoteWorkspaceID(session.workspaceID)
        // Participant deliberately excluded: addressing a different agent inside the same
        // orchestrator is still the same conversation, so those share one session list.
        return remote?.serverID === agent.serverID && remote?.orchestratorID === agent.orchestratorID
      })
      .toSorted((a, b) => b.time.updated - a.time.updated)
  })

  return (
    <Show when={current()}>
      {(agent) => (
        <box>
          <text fg={theme.text}>
            <b>Remote Sessions</b> <span style={{ fg: theme.textMuted }}>{agent().orchestratorID}</span>
          </text>
          <For each={siblings()}>
            {(session) => {
              const active = () => session.id === props.sessionID
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => !active() && route.navigate({ type: "session", sessionID: session.id })}
                >
                  <text flexShrink={0} fg={active() ? theme.success : theme.textMuted}>
                    {active() ? "•" : "◦"}
                  </text>
                  <text fg={active() ? theme.text : theme.textMuted} wrapMode="word">
                    {session.title || "Untitled"}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      )}
    </Show>
  )
}
