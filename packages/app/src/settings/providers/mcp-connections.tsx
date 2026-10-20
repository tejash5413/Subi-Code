import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { ConfigEntry, McpAddInput, McpServer, McpToolInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useMcpToggle } from "@/providers/connect/mcp"
import { SettingsList } from "@/settings/list"
import { McpConnectionForm } from "./mcp-form"

type ServerConfig = McpAddInput["config"]

export function McpConnections() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const dialog = useDialog()
  const [state, setState] = createStore<{
    servers: McpServer[]
    entries: ConfigEntry[]
    tools: McpToolInfo[]
    loading: boolean
    busy: string
    error: string
    authenticate: string
  }>({ servers: [], entries: [], tools: [], loading: true, busy: "", error: "", authenticate: "" })

  const refresh = async () => {
    try {
      const [servers, entries, tools] = await Promise.all([
        sdk.api.mcp.list(),
        sdk.api.config.get(),
        sdk.api.mcp.tools(),
      ])
      setState({ servers: servers.data, entries, tools: tools.data, error: "", loading: false })
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : language.t("common.requestFailed"), loading: false })
    }
  }
  const toggle = useMcpToggle(() => undefined, refresh)
  const configs = createMemo(() => {
    const boundary = state.entries.findIndex((entry) => entry.type === "directory")
    const entries = boundary === -1 ? state.entries : state.entries.slice(0, boundary)
    return new Map<string, ServerConfig>(
      entries.flatMap((entry) => (entry.type === "document" ? Object.entries(entry.info.mcp?.servers ?? {}) : [])),
    )
  })
  createEffect(() => {
    if (sdk.connection.status() === "connected") void refresh()
  })
  onCleanup(sdk.event.on("mcp.status.changed", () => void refresh()))
  onCleanup(sdk.event.on("config.updated", () => void refresh()))
  makeEventListener(window, "focus", () => void refresh())

  createEffect(() => {
    const server = state.servers.find((item) => item.name === state.authenticate)
    if (!server || server.status.status === "pending") return
    setState("authenticate", "")
    if (server.status.status === "needs_auth") toggle.mutate({ name: server.name, enabled: true })
  })

  const run = async (name: string, operation: () => Promise<unknown>) => {
    if (state.busy) return
    setState({ busy: name, error: "" })
    try {
      await operation()
      await refresh()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setState("busy", "")
    }
  }
  const edit = (name?: string) => {
    const config = name ? configs().get(name) : undefined
    void dialog.show(() => (
      <McpConnectionForm
        existing={name && config?.type === "remote" ? { name, url: config.url } : undefined}
        names={state.servers.map((server) => server.name)}
        save={async (name, config) => {
          setState("authenticate", name)
          try {
            await sdk.api.config.update({ mcp: { [name]: config } })
            await refresh()
          } catch (error) {
            setState("authenticate", "")
            throw error
          }
        }}
      />
    ))
  }
  const connect = (server: McpServer) =>
    run(server.name, async () => {
      const config = configs().get(server.name)
      if (config) await sdk.api.config.update({ mcp: { [server.name]: { ...config, disabled: false } } })
      await toggle.mutateAsync({ name: server.name, enabled: true })
    })
  const disconnect = (server: McpServer) =>
    run(server.name, async () => {
      const config = configs().get(server.name)
      if (config) await sdk.api.config.update({ mcp: { [server.name]: { ...config, disabled: true } } })
      await toggle.mutateAsync({ name: server.name, enabled: false })
    })
  const remove = (server: McpServer) =>
    run(server.name, async () => {
      await sdk.api.config.update({ mcp: { [server.name]: null } })
      await sdk.api.mcp.disconnect({ server: server.name }).catch(() => undefined)
    })

  return (
    <div class="settings-section">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="settings-extension-heading text-13-medium">{language.t("settings.extensions.availableAll")}</span>
        <div class="flex items-center gap-2">
          <Button variant="ghost" disabled={state.loading || !!state.busy} onClick={() => void refresh()}>
            {language.t("mcp.connection.refresh")}
          </Button>
          <Button disabled={!!state.busy} onClick={() => edit()}>
            {language.t("mcp.connection.add")}
          </Button>
        </div>
      </div>
      <Show when={state.error}>
        <p role="alert" class="text-13-regular text-v2-text-text-feedback-error">
          {state.error}
        </p>
      </Show>
      <Show when={state.loading}>
        <p class="text-13-regular text-v2-text-text-muted">{language.t("mcp.connection.loading")}</p>
      </Show>
      <Show when={!state.loading && state.servers.length === 0 && !state.error}>
        <div class="rounded-lg border border-v2-border-border-base p-6 text-13-regular text-v2-text-text-muted">
          {language.t("mcp.connection.empty")}
        </div>
      </Show>
      <SettingsList variant="catalog">
        <For each={state.servers}>
          {(server) => {
            const config = () => configs().get(server.name)
            const url = () => {
              const value = config()
              return value?.type === "remote" ? value.url : undefined
            }
            const tools = () => state.tools.filter((tool) => tool.server === server.name)
            return (
              <div class="flex min-w-0 flex-col gap-3 py-4">
                <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <Icon name="mcp" class="shrink-0 text-v2-icon-icon-muted" />
                    <div class="min-w-0 text-13-regular">
                      <div class="font-medium">{server.name}</div>
                      <Show when={url()}>
                        <div class="break-all text-v2-text-text-muted">{url()}</div>
                      </Show>
                      <div role="status" class="text-v2-text-text-muted">
                        {language.t(`mcp.status.${server.status.status}`)}
                      </div>
                    </div>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <Show
                      when={server.status.status === "connected"}
                      fallback={
                        <Button
                          variant="outline"
                          disabled={!!state.busy || toggle.isPending || server.status.status === "pending"}
                          onClick={() => void connect(server)}
                        >
                          {language.t(
                            server.status.status === "needs_auth" ? "mcp.connection.signIn" : "mcp.connection.connect",
                          )}
                        </Button>
                      }
                    >
                      <Button
                        variant="outline"
                        disabled={!!state.busy || toggle.isPending}
                        onClick={() => void connect(server)}
                      >
                        {language.t("mcp.connection.reconnect")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!!state.busy || toggle.isPending}
                        onClick={() => void disconnect(server)}
                      >
                        {language.t("mcp.connection.disconnect")}
                      </Button>
                    </Show>
                    <Show when={config()?.type === "remote"}>
                      <Button variant="ghost" disabled={!!state.busy} onClick={() => edit(server.name)}>
                        {language.t("mcp.connection.edit")}
                      </Button>
                    </Show>
                    <Show when={config()}>
                      <Button variant="ghost" disabled={!!state.busy} onClick={() => void remove(server)}>
                        {language.t("mcp.connection.remove")}
                      </Button>
                    </Show>
                  </div>
                </div>
                <Show when={"error" in server.status}>
                  <p class="break-words text-13-regular text-v2-text-text-muted">
                    {"error" in server.status ? server.status.error : ""}
                  </p>
                </Show>
                <Show when={tools().length > 0}>
                  <details class="text-13-regular">
                    <summary class="cursor-pointer text-v2-text-text-muted">
                      {language.t("mcp.connection.tools")}
                    </summary>
                    <ul class="mt-2 flex flex-col gap-2">
                      <For each={tools()}>
                        {(tool) => (
                          <li>
                            <span class="font-medium">{tool.name}</span>
                            <Show when={tool.description}>
                              <p class="text-v2-text-text-muted">{tool.description}</p>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                </Show>
              </div>
            )
          }}
        </For>
      </SettingsList>
    </div>
  )
}
