import { TextAttributes, type ColorInput } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { wordmark } from "../logo"
import { useTheme } from "../context/theme"

export function Logo(props: { color?: ColorInput; compact?: boolean } = {}) {
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  return (
    <box alignItems="center">
      <Show
        when={!props.compact && dimensions().width >= wordmark[0].length + 4 && dimensions().height >= 20}
        fallback={
          <text fg={props.color ?? theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
            SubiCode
          </text>
        }
      >
        <For each={wordmark}>
          {(line) => (
            <text fg={props.color ?? theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
              {line}
            </text>
          )}
        </For>
      </Show>
    </box>
  )
}
