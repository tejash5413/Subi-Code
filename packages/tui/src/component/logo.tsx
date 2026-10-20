import { TextAttributes, type ColorInput } from "@opentui/core"
import { For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { go, logo } from "../logo"

import { useTheme } from "../context/theme"

export function Logo(props: { color?: ColorInput; compact?: boolean } = {}) {
  const dimensions = useTerminalDimensions()
  const theme = useTheme()

  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 26 ? (
        <For each={go.right.slice(1)}>
          {(line) => (
            <text fg={props.color ?? theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
              {line}
            </text>
          )}
        </For>
      ) : dimensions().width < 50 || props.compact ? (
        <box flexDirection="row">
          <text fg={props.color ?? theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
            SUBI{" "}
          </text>
          <text fg={props.color ?? theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
            CODE
          </text>
        </box>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <text fg={props.color ?? theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
                {line}
              </text>
              <text fg={props.color ?? theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
                {logo.right[index()]}
              </text>
            </box>
          )}
        </For>
      )}
    </box>
  )
}
