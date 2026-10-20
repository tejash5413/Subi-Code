import { LearnSmartAccount } from "@opencode/schema/learnsmart-account"
import { LearnSmartLinks } from "@opencode/util/learnsmart"
import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"

/** Shared by web, desktop and embedded app hosts; checkout stays on LearnSmart. */
export function LearnSmartAccountCard(props: { directory?: string; credentialID?: string; onConnect: () => void }) {
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useServerSDK()
  const data = useData()
  const [state, setState] = createStore<{
    loading: boolean
    value?: LearnSmartAccount.Snapshot
    error: boolean
  }>({ loading: false, error: false })
  let request: AbortController | undefined
  let checkoutPending = false
  const identity = () => `${props.credentialID ?? ""}\0${props.directory ?? ""}`
  const clear = () => {
    request?.abort()
    request = undefined
    setState({ loading: false, value: undefined, error: false })
  }
  const load = async () => {
    if (state.loading || !props.credentialID) return
    const key = identity()
    const location = props.directory ? { directory: props.directory } : undefined
    const controller = new AbortController()
    request = controller
    setState({ loading: true, value: undefined, error: false })
    const timeout = setTimeout(() => {
      if (request !== controller) return
      controller.abort()
      setState({ loading: false, error: true })
    }, 45_000)
    try {
      const value = await sdk.api.rpc(LearnSmartAccount.Contract).get({}, { location, signal: controller.signal })
      if (controller.signal.aborted || key !== identity()) return
      // Renewal can restore admission and the managed model catalog. Re-read it
      // through the existing server data store; never synthesize paid access.
      data.location.provider.invalidate(location)
      data.location.model.invalidate(location)
      await Promise.all([data.location.provider.sync(location), data.location.model.sync(location)])
      if (!controller.signal.aborted && key === identity()) setState({ loading: false, value })
    } catch {
      if (request === controller && !controller.signal.aborted) setState({ loading: false, error: true })
    } finally {
      clearTimeout(timeout)
    }
  }
  createEffect(
    on([() => props.credentialID, () => props.directory], () => {
      clear()
      checkoutPending = false
      void load()
    }),
  )
  onCleanup(
    sdk.event.on("credential.switched", (event) => {
      if (event.data.integrationID !== "learnsmart") return
      clear()
      checkoutPending = false
      void load()
    }),
  )
  const refresh = () => {
    checkoutPending = false
    void load()
  }
  const onFocus = () => {
    if (!checkoutPending) return
    refresh()
  }
  window.addEventListener("focus", onFocus)
  onCleanup(() => {
    clear()
    window.removeEventListener("focus", onFocus)
  })
  const checkout = (kind: keyof typeof LearnSmartLinks) => {
    if (state.loading || state.value?.accountType !== "individual" || state.value.quotaMode === "school_tokens") return
    if (kind === "topup" && state.value.subscription?.active !== true) return
    checkoutPending = true
    platform.openExternal(LearnSmartLinks[kind])
  }
  const number = (value: number | null | undefined, credits = false) =>
    value === null || value === undefined
      ? language.t("settings.learnsmart.unknown")
      : new Intl.NumberFormat(language.intl(), { maximumFractionDigits: credits ? 3 : 0 }).format(
          credits ? value / 1000 : value,
        )
  const date = (value: number | null | undefined) =>
    value === null || value === undefined
      ? language.t("settings.learnsmart.unknown")
      : new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium" }).format(value)

  return (
    <section
      id="settings-learnsmart-account"
      class="settings-section settings-learnsmart"
      aria-labelledby="learnsmart-heading"
      aria-busy={state.loading}
    >
      <div class="settings-learnsmart-heading">
        <h3 id="learnsmart-heading" class="settings-section-title">
          {language.t("settings.learnsmart.title")}
        </h3>
        <Show
          when={props.credentialID}
          fallback={
            <button type="button" onClick={props.onConnect}>
              {language.t("settings.learnsmart.connect")}
            </button>
          }
        >
          <button type="button" onClick={refresh} disabled={state.loading}>
            {language.t("settings.learnsmart.refresh")}
          </button>
        </Show>
      </div>
      <Show when={!props.credentialID}>
        <p>{language.t("settings.learnsmart.signIn")}</p>
      </Show>
      <Show when={state.loading}>
        <p role="status">{language.t("settings.learnsmart.loading")}</p>
      </Show>
      <Show when={state.error}>
        <p role="alert">{language.t("settings.learnsmart.error")}</p>
      </Show>
      <Show when={state.value}>
        {(value) => (
          <>
            <Show when={value().status === "idle"}>
              <p>{language.t("settings.learnsmart.signIn")}</p>
            </Show>
            <Show when={value().errorCode}>
              <p role="status">{language.t("settings.learnsmart.unavailable")}</p>
            </Show>
            <Show when={value().quotaMode === "school_tokens"}>
              <p>{language.t("settings.learnsmart.school")}</p>
              <dl class="settings-learnsmart-balances">
                <div>
                  <dt>{language.t("settings.learnsmart.tokens")}</dt>
                  <dd>{number(value().monthlyLimit.monthlyTokenLimit)}</dd>
                </div>
                <div>
                  <dt>{language.t("settings.learnsmart.remainingTokens")}</dt>
                  <dd>{number(value().usage.remainingTokens)}</dd>
                </div>
              </dl>
            </Show>
            <Show when={value().accountType === "individual" && value().quotaMode !== "school_tokens"}>
              <Show when={value().subscription?.active !== false}>
                <dl class="settings-learnsmart-balances">
                  <div>
                    <dt>{language.t("settings.learnsmart.available")}</dt>
                    <dd>{number(value().credits?.totalAvailableMilli, true)}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.learnsmart.monthly")}</dt>
                    <dd>{number(value().credits?.monthlyRemainingMilli, true)}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.learnsmart.monthlyGrant")}</dt>
                    <dd>{number(value().credits?.monthlyGrantMilli, true)}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.learnsmart.rollover")}</dt>
                    <dd>{number(value().credits?.rolloverRemainingMilli, true)}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.learnsmart.purchased")}</dt>
                    <dd>{number(value().credits?.purchasedRemainingMilli, true)}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.learnsmart.reserved")}</dt>
                    <dd>{number(value().credits?.reservedMilli, true)}</dd>
                  </div>
                  <div>
                    <dt>{language.t("settings.learnsmart.cycle")}</dt>
                    <dd>{date(value().credits?.cycleEndsAtMs)}</dd>
                  </div>
                </dl>
              </Show>
              <p>
                {value().subscription?.active === false
                  ? language.t("settings.learnsmart.expired")
                  : value().subscription?.active === true
                    ? language.t("settings.learnsmart.renewal", { date: date(value().subscription?.renewalDateMs) })
                    : language.t("settings.learnsmart.subscriptionUnknown")}
              </p>
              <Show when={value().credits?.health === "exhausted" && value().subscription?.active === true}>
                <p role="status">{language.t("settings.learnsmart.exhausted")}</p>
              </Show>
              <div class="settings-learnsmart-actions">
                <Show when={value().subscription?.active === true}>
                  <button type="button" onClick={() => checkout("topup")}>
                    {language.t("settings.learnsmart.topup")}
                  </button>
                </Show>
                <button type="button" onClick={() => checkout("subscription")}>
                  {value().subscription?.active
                    ? language.t("settings.learnsmart.renew")
                    : language.t("settings.learnsmart.purchase")}
                </button>
              </div>
              <p>{language.t("settings.learnsmart.checkout")}</p>
              <p>{language.t("settings.learnsmart.rules")}</p>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
