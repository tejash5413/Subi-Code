import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { globalExtensionSources, type ConfigEntry, type PluginInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { ExtensionSourceForm, type ExtensionSourceKind } from "@opencode/ui/extension-source-form"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { pluginLabel } from "@/providers/catalog/plugin"
import { SettingsList } from "@/settings/list"

export function useAddExtensionSource(afterSave?: () => Promise<unknown>) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const dialog = useDialog()
  return (kind: ExtensionSourceKind, existing?: { source: string; options?: Record<string, unknown> }) => {
    void dialog.show(() => {
      const [state, setState] = createStore<{ sources: string[] }>({ sources: [] })
      return (
        <ExtensionSourceForm
          kind={kind}
          existing={existing}
          sources={state.sources}
          translate={language.t}
          close={() => dialog.close()}
          save={async (source, options) => {
            const configured = globalExtensionSources(await sdk.api.config.get())
            const sources = kind === "plugin" ? [...configured.plugins.keys()] : configured.skills
            setState("sources", sources)
            if (source !== existing?.source && sources.includes(source))
              throw new Error(language.t("extensions.source.duplicate"))
            await sdk.api.config.update(
              kind === "plugin"
                ? { plugins: { [source]: options } }
                : {
                    skills: {
                      ...(existing && existing.source !== source ? { [existing.source]: false } : {}),
                      [source]: true,
                    },
                  },
            )
            await afterSave?.()
          }}
        />
      )
    })
  }
}

export function ExtensionSources(props: { kind: ExtensionSourceKind }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const [state, setState] = createStore<{
    entries: ConfigEntry[]
    plugins: PluginInfo[]
    skills: string[]
    loading: boolean
    busy: boolean
    error: string
  }>({ entries: [], plugins: [], skills: [], loading: true, busy: false, error: "" })
  const refresh = async () => {
    try {
      const [entries, plugins, skills] = await Promise.all([
        sdk.api.config.get(),
        sdk.api.plugin.list(),
        sdk.api.skill.list(),
      ])
      setState({
        entries,
        plugins: plugins.data.filter((item) => item.source.type !== "builtin"),
        skills: skills.data.map((item) => item.name),
        loading: false,
        error: "",
      })
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : language.t("common.requestFailed") })
    }
  }
  const add = useAddExtensionSource(refresh)
  createEffect(() => {
    if (sdk.connection.status() === "connected") void refresh()
  })
  onCleanup(sdk.event.on("config.updated", () => void refresh()))
  onCleanup(sdk.event.on("plugin.updated", () => void refresh()))
  onCleanup(sdk.event.on("skill.updated", () => void refresh()))
  const configs = createMemo(() => globalExtensionSources(state.entries))
  const sources = () => (props.kind === "plugin" ? [...configs().plugins.keys()] : configs().skills)
  const remove = async (source: string) => {
    if (state.busy) return
    setState({ busy: true, error: "" })
    try {
      await sdk.api.config.update(
        props.kind === "plugin" ? { plugins: { [source]: null } } : { skills: { [source]: false } },
      )
      await refresh()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <div class="settings-section">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="settings-extension-heading text-13-medium">{language.t("settings.extensions.availableAll")}</span>
        <div class="flex gap-2">
          <Button variant="ghost" disabled={state.busy || state.loading} onClick={() => void refresh()}>
            {language.t("extensions.source.refresh")}
          </Button>
          <Button disabled={state.busy} onClick={() => add(props.kind)}>
            {language.t(`extensions.${props.kind}.add`)}
          </Button>
        </div>
      </div>
      <p class="text-13-regular text-v2-text-text-muted">{language.t("extensions.source.savedHint")}</p>
      <Show when={state.error}>
        <p role="alert" class="text-13-regular text-v2-text-text-feedback-error">
          {state.error}
        </p>
      </Show>
      <Show when={state.loading}>
        <p role="status">{language.t("extensions.source.loading")}</p>
      </Show>
      <h3 class="text-13-medium">{language.t("extensions.source.configured")}</h3>
      <Show when={!state.loading && sources().length === 0}>
        <p class="text-13-regular text-v2-text-text-muted">{language.t("extensions.source.empty")}</p>
      </Show>
      <SettingsList variant="catalog">
        <For each={sources()}>
          {(source) => (
            <div class="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4">
              <span class="min-w-0 break-all text-13-regular">{source}</span>
              <div class="flex gap-2">
                <Button
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => add(props.kind, { source, options: configs().plugins.get(source) })}
                >
                  {language.t("extensions.source.edit")}
                </Button>
                <Button variant="ghost" disabled={state.busy} onClick={() => void remove(source)}>
                  {language.t("extensions.source.remove")}
                </Button>
              </div>
            </div>
          )}
        </For>
      </SettingsList>
      <h3 class="text-13-medium">{language.t("extensions.source.inventory")}</h3>
      <SettingsList variant="catalog">
        <Show
          when={props.kind === "plugin"}
          fallback={<For each={state.skills}>{(name) => <div class="settings-extension-row">{name}</div>}</For>}
        >
          <For each={state.plugins}>
            {(plugin) => (
              <div class="flex flex-col gap-1 py-4 text-13-regular">
                <span>{pluginLabel(plugin)}</span>
                <span class="text-v2-text-text-muted">
                  {language.t(`extensions.plugin.status.${plugin.state.status}`)}
                </span>
                <Show when={plugin.state.status === "failed"}>
                  <p role="alert" class="break-words text-v2-text-text-feedback-error">
                    {plugin.state.status === "failed" ? plugin.state.error : ""}
                  </p>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </SettingsList>
    </div>
  )
}
