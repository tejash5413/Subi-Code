import { Prompt, type PromptRef } from "../component/prompt"
import { Logo } from "../component/logo"
import { createEffect, createMemo, createSignal, onMount, Show, For, untrack } from "solid-js"
import { useArgs } from "../context/args"
import { useRouteData, useRoute } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { FormPrompt } from "./session/form"
import { Slot } from "../plugin/render"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useUpdateNotification } from "../context/update-notification"
import { useExit } from "../context/exit"
import { Product } from "@opencode/util/product"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { FadeInText } from "../component/fade-in-text"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const route = useRouteData("home")
  const navigate = useRoute().navigate
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const data = useData()
  const location = useLocation()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const workspace = () => {
    const directory = currentLocation()?.directory ?? ""
    return directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory
  }
  // Global MCP elicitations can arrive without a session route, so keep them reachable from Home.
  const currentLocation = () => route.location ?? data.location.default()
  const learnsmartConnected = createMemo(() =>
    data.location.integration
      .list(currentLocation())
      ?.some((item) => item.id === "learnsmart" && item.connections.length > 0),
  )
  const forms = createMemo(() => data.session.form.list("global", currentLocation()) ?? [])
  const recent = createMemo(() =>
    data.session
      .list()
      .filter((session) => !session.parentID && session.location?.directory === currentLocation()?.directory)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, 3),
  )
  let sent = false

  // Track only the route location and (when absent) the default location; location.set
  // reads other signals internally and tracking them would re-assert the route location
  // after the user overrides it with /cd.
  createEffect(() => {
    const target = currentLocation()
    untrack(() => location.set(target))
  })

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r || route.prompt || !args.prompt) return
    r.set({ text: args.prompt, files: [], agents: [], pasted: [] })
    once = true
  }

  createEffect(() => {
    const composer = ref()
    const prompt = route.prompt
    if (!composer || prompt?.text === undefined) return
    untrack(() => composer.set(prompt))
  })

  // Wait for everything submit needs before auto-submitting --prompt; it runs once.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!local.model.ready || !local.model.catalogReady) return
    if (!local.agent.current() || !local.model.current()) return
    if (!args.prompt) return
    if (r.current.text !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box
        flexGrow={1}
        alignItems="center"
        paddingLeft={dimensions().width < 44 ? 1 : 2}
        paddingRight={dimensions().width < 44 ? 1 : 2}
      >
        <box width="100%" flexDirection="row" gap={3} paddingTop={1} paddingBottom={1} flexShrink={0}>
          <text fg={theme.text.muted} truncate wrapMode="none" flexShrink={1}>
            {workspace()}
          </text>
          <box flexGrow={1} />
          <Show when={learnsmartConnected() && dimensions().width >= 60}>
            <text fg={theme.text.muted}>
              <span style={{ fg: theme.text.feedback.success.base }}>● </span>LearnSmart · Connected
            </text>
          </Show>
        </box>
        <box
          width="100%"
          maxWidth={96}
          zIndex={1000}
          paddingTop={
            dimensions().height >= 30
              ? Math.max(2, Math.floor(dimensions().height / 8))
              : dimensions().height >= 24
                ? 1
                : 0
          }
          flexShrink={0}
          position="relative"
        >
          <Show when={dimensions().height >= 12}>
            <box id="welcome-wordmark" alignItems="center" gap={1} paddingBottom={dimensions().height >= 26 ? 2 : 1}>
              <Logo color={theme.text.base} compact={dimensions().height < 26} />
              <text fg={theme.text.muted}>{Product.version}</text>
              <Show when={dimensions().width >= 44 && dimensions().height >= 30}>
                <text fg={theme.text.muted} wrapMode="word">
                  What would you like to work on?
                </text>
              </Show>
            </box>
          </Show>
          <UpdateNotification width={Math.max(1, Math.min(84, dimensions().width - 4))} />
          <Prompt ref={bind} placeholders={placeholder} disabled={forms().length > 0} />
          <Show when={dimensions().height >= 34 && recent().length > 0}>
            <box alignItems="center" paddingTop={2}>
              <box gap={0} maxWidth="100%">
                <text fg={theme.text.muted}>Recent sessions</text>
                <For each={recent()}>
                  {(session, index) => (
                    <text
                      fg={theme.text.base}
                      truncate
                      wrapMode="none"
                      onMouseUp={() => navigate({ type: "session", sessionID: session.id })}
                    >
                      <span style={{ fg: theme.text.muted }}>{String(index() + 1).padStart(2, "0")} </span>
                      {withTimestampedFallback(session)}
                    </text>
                  )}
                </For>
              </box>
            </box>
          </Show>
        </box>
        <box flexGrow={1} minHeight={0} />
      </box>
      <box width="100%" flexShrink={0}>
        <Slot path="home.footer" />
      </box>
      <Show when={forms()[0]?.id} keyed>
        {(_) => {
          const form = forms()[0]
          return form ? (
            <box position="absolute" zIndex={2000} left={0} right={0} bottom={1} paddingLeft={2} paddingRight={2}>
              <box width="100%">
                <FormPrompt form={form} />
              </box>
            </box>
          ) : null
        }}
      </Show>
    </>
  )
}

function UpdateNotification(props: { width: number }) {
  const update = useUpdateNotification()
  const exit = useExit()
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const backdrop = () => (hovered() ? theme.background.action.primary.hovered : theme.background.base)
  createEffect(() => {
    update.notification()
    setHovered(false)
  })

  return (
    <Show when={update.notification()} keyed>
      {(state) => {
        const remote = state.source === "server" && state.remote
        return (
          <Show when={!remote || state.type === "available"}>
            <box
              flexShrink={0}
              flexDirection="row"
              justifyContent="center"
              width={props.width}
              maxWidth="100%"
              gap={1}
              backgroundColor={hovered() ? theme.background.action.primary.hovered : undefined}
              onMouseOver={() => setHovered(true)}
              onMouseOut={() => setHovered(false)}
              onMouseUp={() => {
                if (remote) return update.dismiss()
                if (state.type === "installed") return exit()
                update.open?.("notification")
              }}
            >
              <FadeInText fg={theme.text.muted} backdrop={backdrop()}>
                <Show when={!remote}>
                  <span style={{ fg: theme.text.action.primary.selected }}>
                    {state.type === "installed" ? "/exit" : "/update"}
                  </span>
                </Show>
                {remote
                  ? "remote server update available"
                  : state.type === "installed"
                    ? ` restart to use v${state.version}`
                    : ` to install v${state.version}`}
              </FadeInText>
            </box>
          </Show>
        )
      }}
    </Show>
  )
}
