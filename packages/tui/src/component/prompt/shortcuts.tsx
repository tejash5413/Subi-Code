import { For, Show, createMemo } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { useInteractivity } from "../../context/interactivity"

/** Display the configured bindings; hints never install a second keyboard handler. */
export function PromptShortcuts(props: { sessionID?: string; mode: "normal" | "shell" }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const keymap = Keymap.use()
  const shortcuts = Keymap.useShortcuts()
  const interactive = useInteractivity()
  const hints = createMemo(() =>
    [
      {
        key: dimensions().width < 44 ? shortcuts.get("command.palette.show") : undefined,
        label: "menu",
        command: "command.palette.show",
      },
      { key: shortcuts.get("agent.cycle"), label: "agent", command: "agent.cycle" },
      { key: shortcuts.get("model.list"), label: "models", command: "model.list" },
      { key: "@", label: "files" },
      { key: shortcuts.get("prompt.paste"), label: "paste", command: "prompt.paste" },
      {
        key: [shortcuts.get("prompt.history.previous"), shortcuts.get("prompt.history.next")].filter(Boolean).join("/"),
        label: "history",
      },
      {
        key: shortcuts.get("session.interrupt"),
        label: "stop",
        command: props.sessionID ? "session.interrupt" : undefined,
      },
    ].filter((hint) => hint.key),
  )

  return (
    <Show when={props.mode === "normal" && dimensions().height >= 20}>
      <box
        width="100%"
        flexDirection="row"
        flexWrap="wrap"
        columnGap={3}
        rowGap={0}
        paddingTop={props.sessionID ? 0 : 1}
      >
        <For each={hints()}>
          {(hint) => (
            <text
              fg={theme.text.muted}
              wrapMode="none"
              onMouseUp={() => {
                if (interactive() && hint.command) keymap.dispatch(hint.command)
              }}
            >
              <span style={{ fg: interactive() ? theme.text.base : theme.text.muted }}>{hint.key}</span> {hint.label}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
