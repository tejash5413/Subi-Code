import { createSignal, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import { useTheme } from "../../context/theme"

export function SidebarSection(props: {
  title: string
  summary?: string
  rows: number
  children: JSX.Element
  overview?: JSX.Element
}) {
  const theme = useTheme()
  const [open, setOpen] = createSignal(true)
  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between" onMouseUp={() => setOpen((value) => !value)}>
        <text fg={theme.text.base}>
          <b>{props.title}</b>
          <span style={{ fg: theme.text.muted }}>{props.summary ? ` · ${props.summary}` : ""}</span>
        </text>
        <text fg={theme.text.action.primary.selected}>{open() ? "▲" : "▼"}</text>
      </box>
      <Show when={open()}>
        {props.overview}
        <scrollbox
          height={Math.min(8, Math.max(1, props.rows))}
          flexShrink={0}
          horizontalScrollbarOptions={{ visible: false }}
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.background.raised.base, foregroundColor: theme.scrollbar.base },
          }}
        >
          <box gap={0} flexShrink={0}>
            {props.children}
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}
