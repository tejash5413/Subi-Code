import type { Plugin } from "@opencode/plugin/tui"
import { LearnSmartAccount } from "@opencode/schema/learnsmart-account"
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useLocal } from "../../context/local"

export function SidebarAccount(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const local = useLocal()
  const location = createMemo(() => props.context.data.session.get(props.sessionID)?.location ?? props.context.location)
  const connected = createMemo(
    () =>
      local.model.current()?.providerID === "learnsmart" &&
      props.context.data.location.integration
        .list(location())
        ?.some((item) => item.id === "learnsmart" && item.connections.length > 0),
  )
  const [value, setValue] = createSignal<LearnSmartAccount.Snapshot>()
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  let request: AbortController | undefined
  const clear = () => {
    request?.abort()
    request = undefined
    setValue(undefined)
    setLoading(false)
    setFailed(false)
  }
  const load = async () => {
    clear()
    if (!connected()) return
    const controller = new AbortController()
    request = controller
    setLoading(true)
    const timeout = setTimeout(() => controller.abort(), 45_000)
    try {
      const result = await props.context.client
        .rpc(LearnSmartAccount.Contract)
        .get({}, { location: location(), signal: controller.signal })
      if (request === controller && !controller.signal.aborted) setValue(result)
    } catch {
      if (request === controller) setFailed(true)
    } finally {
      clearTimeout(timeout)
      if (request === controller) setLoading(false)
    }
  }
  createEffect(
    on(
      () => [connected(), props.sessionID] as const,
      () => {
        void load()
      },
    ),
  )
  createEffect(
    on(
      () => props.context.data.session.status(props.sessionID),
      (status, previous) => {
        if (previous === "running" && status !== "running") void load()
      },
    ),
  )
  onCleanup(
    props.context.data.on("credential.switched", (event) => {
      if (event.data.integrationID === "learnsmart") void load()
    }),
  )
  onCleanup(clear)
  return (
    <Show when={connected()}>
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.base}>
            <b>LearnSmart</b>
          </text>
          <text
            fg={theme.text.muted}
            onMouseUp={() => {
              if (!loading()) void load()
            }}
          >
            Refresh
          </text>
        </box>
        <Show when={loading()}>
          <text fg={theme.text.muted}>Loading balance…</text>
        </Show>
        <Show when={failed()}>
          <text fg={theme.text.muted}>Balance unavailable · retry Refresh</text>
        </Show>
        <Show when={value()}>
          {(account) => (
            <>
              <Show
                when={account().status === "allowed"}
                fallback={<text fg={theme.text.muted}>Account {account().status} · /account</text>}
              >
                <Show when={account().quotaMode === "school_tokens"}>
                  <text fg={theme.text.base}>School tokens</text>
                  <text fg={theme.text.muted}>
                    {account().monthlyLimit.configured
                      ? `${amount(account().monthlyLimit.monthlyTokenLimit)} monthly limit`
                      : "Allowance not configured"}
                  </text>
                  <text fg={theme.text.muted}>
                    {account().usage.status === "ready"
                      ? `${amount(account().usage.remainingTokens)} remaining`
                      : "Usage unavailable"}
                  </text>
                </Show>
                <Show when={account().accountType === "individual" && account().quotaMode === "individual_credits"}>
                  <text fg={theme.text.base}>
                    {account().subscription?.active === false
                      ? "Subscription inactive · /account"
                      : (account().credits?.totalAvailableMilli ?? null) === null
                        ? "Credits unavailable"
                        : `${amount(account().credits?.totalAvailableMilli, 1000)} credits available`}
                  </text>
                </Show>
              </Show>
            </>
          )}
        </Show>
      </box>
    </Show>
  )
}

function amount(value: number | null | undefined, divisor = 1) {
  if (value === null || value === undefined) return "Unavailable"
  return (value / divisor).toLocaleString("en-US", { maximumFractionDigits: 3 })
}
