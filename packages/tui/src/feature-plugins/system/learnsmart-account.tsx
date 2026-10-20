import { Plugin } from "@opencode/plugin/tui"
import { LearnSmartAccount } from "@opencode/schema/learnsmart-account"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useRenderer } from "@opentui/solid"
import { openUrl } from "@opencode/util/open"
import { LearnSmartLinks } from "@opencode/util/learnsmart"
import { useTheme } from "../../context/theme"

export function AccountPage(props: { context: Plugin.Context; onClose: () => void }) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [state, setState] = createStore<{ loading: boolean; value?: LearnSmartAccount.Snapshot; error?: string }>({
    loading: true,
  })
  let request: AbortController | undefined
  let checkoutPending = false
  const load = async () => {
    request?.abort()
    const controller = new AbortController()
    request = controller
    const timeout = setTimeout(() => controller.abort(), 45_000)
    setState({ loading: true, value: undefined, error: undefined })
    try {
      const value = await props.context.client
        .rpc(LearnSmartAccount.Contract)
        .get({}, { location: props.context.location, signal: controller.signal })
      if (!controller.signal.aborted) setState({ loading: false, value })
    } catch {
      if (request === controller)
        setState({ loading: false, error: "Unable to refresh your LearnSmart account. Press r to try again." })
    } finally {
      clearTimeout(timeout)
    }
  }
  const checkout = (kind: keyof typeof LearnSmartLinks) => {
    if (state.loading || state.value?.accountType !== "individual" || state.value.quotaMode === "school_tokens") return
    if (kind === "topup" && state.value.subscription?.active !== true) return
    checkoutPending = true
    void openUrl(LearnSmartLinks[kind]).catch(() => {
      checkoutPending = false
      setState("error", "Unable to open LearnSmart checkout. Try the displayed purchase link.")
    })
  }
  const onFocus = () => {
    if (!checkoutPending || state.loading) return
    checkoutPending = false
    void load()
  }
  renderer.on("focus", onFocus)
  onCleanup(() => renderer.off("focus", onFocus))
  onMount(() => void load())
  onCleanup(() => {
    request?.abort()
    request = undefined
  })
  onCleanup(
    props.context.data.on("credential.switched", (event) => {
      if (event.data.integrationID === "learnsmart") {
        checkoutPending = false
        void load()
      }
    }),
  )
  props.context.keymap.layer(() => ({
    commands: [
      { bind: "escape", title: "back", run: props.onClose },
      { bind: "p", title: "Top up credits", run: () => checkout("topup") },
      { bind: "n", title: "Purchase or renew subscription", run: () => checkout("subscription") },
      {
        bind: "r",
        title: "Refresh account",
        run: () => {
          if (!state.loading) void load()
        },
      },
    ],
  }))

  return (
    <box width="100%" height="100%" backgroundColor={theme.background.base} padding={2} gap={1}>
      <text fg={theme.text.base}>LearnSmart account</text>
      <scrollbox flexGrow={1}>
        <box gap={1}>
          <Show when={state.loading}>
            <text fg={theme.text.muted}>Loading models, limits and credits…</text>
          </Show>
          <Show when={state.error}>
            <text fg={theme.text.feedback.error.base} wrapMode="word">
              {state.error}
            </text>
          </Show>
          <Show when={state.value}>
            {(value) => (
              <>
                <text fg={theme.text.base}>
                  {value().accountType ? `${value().accountType} account · ` : ""}
                  {value().status}
                </text>
                <Show when={value().status === "idle"}>
                  <text fg={theme.text.muted}>Sign in with /connect → LearnSmart.</text>
                </Show>
                <Show when={value().errorCode}>
                  <text fg={theme.text.feedback.error.base} wrapMode="word">
                    Account unavailable: {value().errorCode}
                  </text>
                </Show>
                <Show when={value().quotaMode === "school_tokens"}>
                  <text fg={theme.text.muted} wrapMode="word">
                    Your school manages access and monthly token allowances.
                  </text>
                  <text fg={theme.text.base} wrapMode="word">
                    Monthly token limit: {number(value().monthlyLimit.monthlyTokenLimit)}
                  </text>
                  <text fg={theme.text.base} wrapMode="word">
                    Used: {number(value().usage.usedTokens)} · Remaining: {number(value().usage.remainingTokens)}
                  </text>
                </Show>
                <Show when={value().accountType === "individual" && value().quotaMode !== "school_tokens"}>
                  <Show when={value().subscription?.active !== false}>
                    <box gap={0}>
                      <text fg={theme.text.base} wrapMode="word">
                        Available: {credit(value().credits?.totalAvailableMilli)} credits
                      </text>
                      <text fg={theme.text.muted} wrapMode="word">
                        Monthly: {credit(value().credits?.monthlyRemainingMilli)} /{" "}
                        {credit(value().credits?.monthlyGrantMilli)}
                      </text>
                      <text fg={theme.text.muted} wrapMode="word">
                        Rollover: {credit(value().credits?.rolloverRemainingMilli)} · Purchased:{" "}
                        {credit(value().credits?.purchasedRemainingMilli)}
                      </text>
                      <text fg={theme.text.muted} wrapMode="word">
                        Reserved: {credit(value().credits?.reservedMilli)}
                      </text>
                      <text fg={theme.text.muted} wrapMode="word">
                        Credit cycle ends: {date(value().credits?.cycleEndsAtMs)}
                      </text>
                    </box>
                  </Show>
                  <Show when={value().subscription?.active === false}>
                    <text fg={theme.text.feedback.warning.base} wrapMode="word">
                      Subscription expired or inactive. Purchase or renew subscription to restore coding access.
                      Purchased credits remain subject to LearnSmart's account rules.
                    </text>
                  </Show>
                  <Show when={value().credits?.health === "exhausted" && value().subscription?.active === true}>
                    <text fg={theme.text.feedback.warning.base} wrapMode="word">
                      Credits exhausted. Top up credits to continue.
                    </text>
                  </Show>
                  <box gap={0}>
                    <Show when={value().subscription?.active === true}>
                      <text fg={theme.text.base} onMouseUp={() => checkout("topup")}>
                        <a href={LearnSmartLinks.topup}>p · Top up credits</a>
                      </text>
                    </Show>
                    <text fg={theme.text.base} onMouseUp={() => checkout("subscription")} wrapMode="word">
                      <a href={LearnSmartLinks.subscription}>
                        n · {value().subscription?.active ? "Renew subscription" : "Purchase or renew subscription"}
                      </a>
                    </text>
                  </box>
                  <text fg={theme.text.muted} wrapMode="word">
                    Checkout and receipts open in LearnSmart. Use the same account. After payment, return here and press
                    r to refresh. Top-ups add credits; renewal extends coverage.
                  </text>
                </Show>
                <Show when={value().subscription}>
                  {(subscription) => (
                    <text fg={theme.text.base} wrapMode="word">
                      Subscription: {subscription().active ? "active" : "inactive"} · Renewal:{" "}
                      {subscription().renewalDateMs === null
                        ? "unknown"
                        : new Date(subscription().renewalDateMs!).toLocaleDateString()}
                    </text>
                  )}
                </Show>
                <Show when={value().usage.errorCode}>
                  <text fg={theme.text.feedback.error.base} wrapMode="word">
                    Usage unavailable: {value().usage.errorCode}
                  </text>
                </Show>
                <Show when={value().models.length > 0}>
                  <text fg={theme.text.base}>Assigned models</text>
                  <For each={value().models}>
                    {(model) => (
                      <text fg={theme.text.base} wrapMode="word">
                        {model.displayName} · context {number(model.contextLength)}
                      </text>
                    )}
                  </For>
                  <text fg={theme.text.muted} wrapMode="word">
                    {value().inferenceAvailable
                      ? "Assigned coding models are available in the model picker."
                      : "Managed inference is unavailable on the connected gateway. These assignments are account data."}
                  </text>
                </Show>
              </>
            )}
          </Show>
        </box>
      </scrollbox>
      <text fg={theme.text.muted}>r refresh · esc back</text>
    </box>
  )
}

function number(value: number | null | undefined) {
  return value === null || value === undefined ? "unknown" : value.toLocaleString("en-US")
}

function credit(value: number | null | undefined) {
  return value === null || value === undefined
    ? "unknown"
    : (value / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })
}

function date(value: number | null | undefined) {
  return value === null || value === undefined ? "unknown" : new Date(value).toLocaleDateString()
}

export default Plugin.define({
  id: "subi.learnsmart.account",
  setup(context) {
    const [previous, setPrevious] = createSignal({ ...context.ui.router.current() })
    context.ui.router.register({
      name: "account",
      render: () => <AccountPage context={context} onClose={() => context.ui.router.navigate(previous())} />,
    })
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "learnsmart.account",
              title: "LearnSmart account",
              group: "System",
              slash: { name: "account" },
              palette: true,
              run() {
                const current = context.ui.router.current()
                if (current.type === "plugin" && current.name === "account") return
                setPrevious({ ...current })
                context.ui.dialog.clear()
                context.ui.router.navigate({ type: "plugin", name: "account" })
              },
            },
          ],
        }))
        return null
      },
    })
  },
})
