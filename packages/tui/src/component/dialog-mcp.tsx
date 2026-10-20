import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { McpServer } from "@opencode/client"
import { useToast } from "../ui/toast"
import { DialogErrorDetails } from "./dialog-error-details"
import { DialogIntegration } from "./dialog-integration"
import { useLocation } from "../context/location"
import { DialogPrompt } from "../ui/dialog-prompt"

function statusError(status: McpServer["status"]) {
  if (status.status === "failed" || status.status === "needs_auth") return status.error
  return undefined
}

function Status(props: { status: McpServer["status"]; loading: boolean }) {
  if (props.loading || props.status.status === "pending") {
    return <>Connecting …</>
  }
  if (props.status.status === "connected") {
    return <span style={{ attributes: TextAttributes.BOLD }}>Connected ✓</span>
  }
  if (props.status.status === "failed") {
    return <>Failed !</>
  }
  if (props.status.status === "needs_auth") {
    return <>Sign in required →</>
  }
  return <>Disabled ○</>
}

export function DialogMcp(props: { initialServer?: string; details?: boolean } = {}) {
  const data = useData()
  const dialog = useDialog()
  const client = useClient()
  const location = useLocation()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const current = () => location.ref ?? data.location.default()
  const servers = createMemo(() =>
    pipe(
      data.location.mcp.server.list(current()) ?? [],
      sortBy((server) => server.name),
    ),
  )
  const initial = props.initialServer ? servers().find((server) => server.name === props.initialServer) : undefined
  const [focused, setFocused] = createSignal<string | undefined>(props.initialServer)
  const [detail, setDetail] = createSignal<McpServer | undefined>(
    props.details && initial?.status.status === "failed" ? initial : undefined,
  )
  const [loading, setLoading] = createSignal<ReadonlySet<string>>(new Set())
  const [form, setForm] = createStore({ step: "", name: "", url: "", error: "", busy: false, authenticate: "" })

  const refresh = async () => {
    data.location.mcp.server.invalidate(current())
    data.location.integration.invalidate(current())
    await Promise.all([data.location.mcp.server.sync(current()), data.location.integration.sync(current())])
  }
  createEffect(() => {
    const server = servers().find((entry) => entry.name === form.authenticate)
    if (!server || server.status.status === "pending") return
    setForm("authenticate", "")
    if (server.status.status === "needs_auth" && server.integrationID)
      dialog.replace(() => <DialogIntegration integrationID={server.integrationID} autoConnect />)
  })
  const submit = async (value: string) => {
    if (form.busy) return
    const text = value.trim()
    if (form.step === "name") {
      if (!text) return setForm("error", "Enter an app name.")
      if (servers().some((server) => server.name === text))
        return setForm("error", "A connection with this name already exists.")
      setForm({ step: "url", name: text, error: "" })
      return
    }
    if (
      !URL.canParse(text) ||
      !["http:", "https:"].includes(new URL(text).protocol) ||
      new URL(text).username ||
      new URL(text).password
    )
      return setForm("error", "Enter an HTTP or HTTPS MCP URL without embedded credentials.")
    setForm({ busy: true, url: text, error: "", authenticate: form.name })
    try {
      await client.api.config.update({ mcp: { [form.name]: { type: "remote", url: text, disabled: false } } })
      await refresh()
      setForm("step", "")
      toast.show({ variant: "success", message: "MCP connection saved in SubiCode configuration" })
    } catch (error) {
      setForm("authenticate", "")
      setForm("error", error instanceof Error ? error.message : String(error))
    } finally {
      setForm("busy", false)
    }
  }

  const statusColor = (status: McpServer["status"]) => {
    if (status.status === "connected") return theme.text.feedback.success.base
    if (status.status === "failed") return theme.text.feedback.error.base
    if (status.status === "needs_auth") return theme.text.feedback.warning.base
    return theme.text.muted
  }

  createEffect(() => {
    if (focused()) return
    const first = servers()[0]
    if (first) setFocused(first.name)
  })

  const options = createMemo(() => {
    const loadingMcp = loading()
    return servers().map((server) => {
      const pending = loadingMcp.has(server.name) || server.status.status === "pending"
      return {
        value: server.name,
        title: server.name,
        footer: <Status status={server.status} loading={pending} />,
        footerColor: pending ? theme.text.muted : statusColor(server.status),
      }
    })
  })

  const focusedServer = createMemo(() => servers().find((server) => server.name === focused()))

  const toggleTitle = createMemo(() => {
    const status = focusedServer()?.status.status
    if (status === "connected") return "disconnect"
    if (status === "failed") return "retry"
    if (status === "needs_auth") return "sign in"
    return "connect"
  })

  const focusedError = createMemo(() => {
    const server = focusedServer()
    // Enter starts sign-in for auth-gated integrations instead of showing the auth reason
    if (server?.status.status === "needs_auth" && server.integrationID) return undefined
    return server ? statusError(server.status) : undefined
  })

  const select = (name: string | undefined) => {
    const server = servers().find((entry) => entry.name === name)
    if (!server) return
    if (server.status.status === "needs_auth" && server.integrationID) {
      dialog.replace(() => <DialogIntegration integrationID={server.integrationID} autoConnect />)
      return
    }
    if (!statusError(server.status)) return
    setDetail(server)
  }

  // Auth-gated servers enter the integration flow; other inactive states retry the connection.
  // The mcp.status.changed event refreshes the list, so no manual sync is needed.
  const toggle = (name: string) => {
    if (loading().has(name)) return
    const server = servers().find((entry) => entry.name === name)
    if (!server || server.status.status === "pending") return
    if (server.status.status === "needs_auth" && server.integrationID) {
      select(name)
      return
    }
    setLoading((prev) => new Set(prev).add(name))
    const target = current()
    const input = { server: name, location: { directory: target.directory } }
    const call = server.status.status === "connected" ? client.api.mcp.disconnect(input) : client.api.mcp.connect(input)
    void call.catch(toast.error).finally(() =>
      setLoading((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      }),
    )
  }

  return (
    <box>
      <Show
        when={form.step}
        fallback={
          <Show
            when={detail()}
            fallback={
              <DialogSelect
                title="MCP servers"
                searchInTitle
                titlePlaceholder="Search MCP servers"
                options={options()}
                preserveSelection
                onMove={(option) => setFocused(option.value as string)}
                onSelect={(option) => select(option.value as string)}
                actions={[
                  {
                    title: "add app",
                    command: "dialog.mcp.add",
                    bind: "ctrl+a",
                    selection: "none",
                    onTrigger: () => setForm({ step: "name", name: "", url: "", error: "" }),
                  },
                  {
                    title: "refresh",
                    command: "dialog.mcp.refresh",
                    bind: "ctrl+r",
                    selection: "none",
                    onTrigger: () => void refresh().catch(toast.error),
                  },
                  {
                    title: toggleTitle(),
                    command: "dialog.mcp.toggle",
                    onTrigger: (option) => {
                      setFocused(option.value as string)
                      toggle(option.value as string)
                    },
                  },
                ]}
                footerHints={focusedError() ? [{ title: "view error", label: "enter", group: "primary" }] : []}
              />
            }
          >
            {(server) => (
              <DialogErrorDetails
                title={`MCP server: ${server().name}`}
                error={statusError(server().status) ?? "Unknown MCP connection error"}
                context={`Status: ${server().status.status}\nConfiguration: mcp.servers.${server().name}${
                  server().integrationID ? `\nIntegration: ${server().integrationID}` : ""
                }`}
                onBack={() => {
                  setDetail(undefined)
                  dialog.setSize("medium")
                }}
              />
            )}
          </Show>
        }
      >
        <Show
          when={form.step === "name"}
          fallback={
            <DialogPrompt
              title={`Connect ${form.name}`}
              subtitle="MCP server URL · saved for all projects"
              placeholder="https://example.com/mcp"
              busy={form.busy}
              busyText="Saving connection…"
              value={form.url}
              description={() => (
                <Show when={form.error}>
                  <text fg={theme.text.feedback.error.base}>{form.error}</text>
                </Show>
              )}
              onConfirm={(value) => void submit(value)}
              onCancel={() => setForm({ step: "", error: "" })}
            />
          }
        >
          <DialogPrompt
            title="Add MCP connection"
            subtitle="App name"
            placeholder="App name"
            value={form.name}
            description={() => (
              <Show when={form.error}>
                <text fg={theme.text.feedback.error.base}>{form.error}</text>
              </Show>
            )}
            onConfirm={(value) => void submit(value)}
            onCancel={() => setForm({ step: "", error: "" })}
          />
        </Show>
      </Show>
    </box>
  )
}
