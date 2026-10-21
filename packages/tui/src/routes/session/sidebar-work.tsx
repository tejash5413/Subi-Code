import { createMemo, For, Show } from "solid-js"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { sidebarChanges, sidebarStatus, sidebarTodos } from "../../util/sidebar"
import { sessionFamily } from "../../util/session"
import { SidebarSection } from "./sidebar-section"
import { Locale } from "../../util/locale"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"

export function SidebarWork(props: { sessionID: string; onSelect: (id: string) => void }) {
  const data = useData()
  const theme = useTheme()
  const messages = createMemo(() => data.session.message.list(props.sessionID))
  const todos = createMemo(() => sidebarTodos(messages()))
  const changes = createMemo(() => sidebarChanges(messages()))
  const totals = createMemo(() =>
    changes().reduce(
      (sum, file) => ({
        additions: sum.additions + (file.additions ?? 0),
        deletions: sum.deletions + (file.deletions ?? 0),
        partial: sum.partial || file.additions === undefined || file.deletions === undefined,
      }),
      { additions: 0, deletions: 0, partial: false },
    ),
  )
  const agents = createMemo(() =>
    sessionFamily(data.session.list(), props.sessionID).filter(({ session }) => session.id !== props.sessionID),
  )
  return (
    <>
      <SidebarSection
        title="Todo"
        summary={todos().length ? `${todos().filter((todo) => todo.done).length}/${todos().length}` : undefined}
        rows={todos().length * 2 || 2}
      >
        <Show
          when={todos().length}
          fallback={
            <text fg={theme.text.muted} wrapMode="word">
              No tasks recorded yet.
            </text>
          }
        >
          <For each={todos()}>
            {(todo) => (
              <text fg={todo.done || todo.status === "cancelled" ? theme.text.muted : theme.text.base} wrapMode="word">
                {todo.done
                  ? "[x]"
                  : todo.status === "in_progress"
                    ? "[>]"
                    : todo.status === "cancelled"
                      ? "[-]"
                      : "[ ]"}{" "}
                {todo.text}
              </text>
            )}
          </For>
        </Show>
      </SidebarSection>
      <Show when={agents().length}>
        <SidebarSection title="Parallel agents" summary={String(agents().length)} rows={agents().length * 2}>
          <For each={agents()}>
            {({ session }) => (
              <box onMouseUp={() => props.onSelect(session.id)}>
                <text fg={theme.text.action.primary.selected} truncate>
                  {"› "}
                  {withTimestampedFallback(session)}
                </text>
                <text fg={theme.text.muted}>
                  {sidebarStatus(
                    data.session.message.list(session.id),
                    data.session.status(session.id) === "running",
                    session.outcome,
                  )}
                </text>
              </box>
            )}
          </For>
        </SidebarSection>
      </Show>
      <Show when={changes().length}>
        <SidebarSection
          title="Changes"
          summary={String(changes().length)}
          rows={changes().length * 2}
          overview={
            <text fg={theme.text.muted}>
              {totals().partial ? "Known total" : "Total"}{" "}
              <span style={{ fg: theme.text.feedback.success.base }}>+{totals().additions.toLocaleString()}</span>{" "}
              <span style={{ fg: theme.text.feedback.error.base }}>−{totals().deletions.toLocaleString()}</span>
            </text>
          }
        >
          <For each={changes()}>
            {(file) => (
              <box flexShrink={0}>
                <text fg={theme.text.base} wrapMode="none">
                  {Locale.truncateMiddle(file.path, 33)}
                </text>
                <text fg={theme.text.muted}>
                  {file.status === "added" ? "Created" : file.status === "deleted" ? "Deleted" : "Edited"}
                  <Show when={file.additions !== undefined && file.deletions !== undefined}>
                    {" · "}
                    <span style={{ fg: theme.text.feedback.success.base }}>+{file.additions}</span>{" "}
                    <span style={{ fg: theme.text.feedback.error.base }}>−{file.deletions}</span>
                  </Show>
                </text>
              </box>
            )}
          </For>
        </SidebarSection>
      </Show>
    </>
  )
}
