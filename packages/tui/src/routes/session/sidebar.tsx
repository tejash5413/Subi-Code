import { useData } from "../../context/data"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { Slot } from "../../plugin/render"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { TextAttributes } from "@opentui/core"
import { Product } from "@opencode/util/product"
import { Keymap } from "../../context/keymap"
import { useDialog } from "../../ui/dialog"
import { SidebarWork } from "./sidebar-work"
import { sidebarActivity, sidebarStatus } from "../../util/sidebar"
import { sessionFamily } from "../../util/session"
import "../../component/title-shimmer"

import { getScrollAcceleration } from "../../util/scroll"
import { SESSION_SIDEBAR_WIDTH } from "../../ui/layout"

export function Sidebar(props: { sessionID: string }) {
  const data = useData()
  const theme = useTheme()
  const config = useConfig().data
  const session = createMemo(() => data.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const dialog = useDialog()
  const [selected, setSelected] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const activity = createMemo(() => sidebarActivity(data.session.message.list(selected() ?? "")))
  const back = () => setSelected(undefined)
  createEffect(() => {
    props.sessionID
    back()
  })
  createEffect(() => {
    const id = selected()
    if (!id) return
    let current = true
    setLoading(true)
    setFailed(false)
    void data.session.message
      .sync(id)
      .catch(() => {
        if (current) setFailed(true)
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    onCleanup(() => {
      current = false
    })
  })
  Keymap.createLayer(() => ({
    mode: "global",
    priority: 20,
    enabled: () => !!selected() && dialog.stack.length === 0,
    commands: [{ bind: "escape", title: "Back to sidebar overview", run: back }],
  }))
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "sidebar.agents.inspect",
        title: "Inspect parallel agent in sidebar",
        group: "Session",
        palette: true,
        enabled: () =>
          sessionFamily(data.session.list(), props.sessionID).some(({ session }) => session.id !== props.sessionID),
        run: () => {
          const first = sessionFamily(data.session.list(), props.sessionID).find(
            ({ session }) => session.id !== props.sessionID,
          )
          if (first) {
            dialog.clear()
            setSelected(first.session.id)
          }
        },
      },
    ],
  }))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.background.raised.base}
        width={SESSION_SIDEBAR_WIDTH}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position="relative"
      >
        <box flexShrink={0} paddingBottom={1} alignItems="flex-end">
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            SubiCode {Product.version}
          </text>
        </box>
        <box flexShrink={0} paddingRight={2} paddingBottom={1}>
          <title_shimmer
            fg={theme.text.base}
            rename={{
              pending: data.session.title.pending(props.sessionID),
              title: withTimestampedFallback(session()),
            }}
            enabled={config.animations ?? true}
            backdrop={theme.background.raised.base}
            attributes={
              data.session.title.pending(props.sessionID) && config.animations === false
                ? TextAttributes.DIM
                : TextAttributes.BOLD
            }
          >
            {withTimestampedFallback(session())}
          </title_shimmer>
        </box>
        <scrollbox
          flexGrow={1}
          minHeight={0}
          scrollAcceleration={scrollAcceleration()}
          // The sidebar only scrolls vertically; a horizontal bar steals a row during initial layout.
          horizontalScrollbarOptions={{ visible: false }}
          verticalScrollbarOptions={{
            // Use the content's reserved right padding instead of changing its width when the bar toggles.
            position: "absolute",
            right: 0,
            top: 0,
            width: 1,
            height: "100%",
            trackOptions: {
              backgroundColor: theme.background.raised.base,
              foregroundColor: theme.scrollbar.base,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <Show
              when={selected()}
              fallback={
                <>
                  <Slot path="sidebar.content" input={{ sessionID: props.sessionID }} />
                  <SidebarWork sessionID={props.sessionID} onSelect={setSelected} />
                </>
              }
            >
              {(id) => (
                <>
                  <text fg={theme.text.action.primary.selected} onMouseUp={back}>
                    ‹ Back · Esc
                  </text>
                  <box>
                    <text fg={theme.text.base} wrapMode="word">
                      <b>{withTimestampedFallback(data.session.get(id()))}</b>
                    </text>
                    <text fg={theme.text.muted}>
                      {sidebarStatus(data.session.message.list(id()), data.session.status(id()) === "running")} ·
                      read-only
                    </text>
                  </box>
                  <Show when={loading()}>
                    <text fg={theme.text.muted}>Loading activity…</text>
                  </Show>
                  <Show when={failed()}>
                    <text fg={theme.text.feedback.error.base}>Activity unavailable. Go back and retry.</text>
                  </Show>
                  <For each={activity()}>
                    {(text) => (
                      <text fg={theme.text.base} wrapMode="word">
                        {text}
                      </text>
                    )}
                  </For>
                  <Show when={!loading() && !failed() && !activity().length}>
                    <text fg={theme.text.muted}>No activity recorded yet.</text>
                  </Show>
                </>
              )}
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Slot path="sidebar.footer" input={{ sessionID: props.sessionID }} />
        </box>
      </box>
    </Show>
  )
}
