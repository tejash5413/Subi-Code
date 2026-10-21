import { createSignal, Show } from "solid-js"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import { useTheme } from "../context/theme"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"

/** Bounded output keeps large file writes/diffs from taking over the transcript. */
export function FilePreview(props: { lines: number; children: JSX.Element }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)
  const [contentRows, setContentRows] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined
  return (
    <box flexShrink={0}>
      <Show when={Math.max(props.lines, contentRows()) > 8}>
        <text
          fg={theme.text.action.primary.selected}
          onMouseUp={() => {
            scroll?.scrollTo(0)
            setExpanded((value) => !value)
          }}
        >
          {expanded() ? "▲ Collapse" : "▼ Expand"} · {props.lines.toLocaleString()} lines
        </text>
      </Show>
      <scrollbox
        ref={(value) => {
          scroll = value
        }}
        height={Math.min(
          Math.max(1, props.lines, contentRows()),
          expanded() ? Math.max(8, Math.min(20, Math.floor(dimensions().height / 2))) : 8,
        )}
        flexShrink={0}
        horizontalScrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.background.base, foregroundColor: theme.scrollbar.base },
        }}
      >
        <box
          flexShrink={0}
          minWidth={0}
          onSizeChange={function (this: BoxRenderable) {
            setContentRows(this.height)
          }}
        >
          {props.children}
        </box>
      </scrollbox>
    </box>
  )
}
