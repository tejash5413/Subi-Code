import { Show } from "solid-js"
import { createStore } from "solid-js/store"

import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"

export type RemoteMcpFormKey =
  | "mcp.connection.add"
  | "mcp.connection.edit"
  | "mcp.connection.description"
  | "mcp.connection.name"
  | "mcp.connection.url"
  | "mcp.connection.authentication"
  | "mcp.connection.auth.keep"
  | "mcp.connection.auth.auto"
  | "mcp.connection.auth.none"
  | "mcp.connection.advanced"
  | "mcp.connection.registrationHint"
  | "mcp.connection.clientID"
  | "mcp.connection.scope"
  | "mcp.connection.nameRequired"
  | "mcp.connection.duplicate"
  | "mcp.connection.invalidURL"
  | "mcp.connection.saving"
  | "mcp.connection.saveConnect"
  | "common.requestFailed"
  | "common.cancel"

export function RemoteMcpConnectionForm(props: {
  existing?: { name: string; url: string }
  names: string[]
  translate: (key: RemoteMcpFormKey) => string
  close: () => void
  save: (
    name: string,
    config: {
      type: "remote"
      url: string
      disabled: boolean
      oauth?: false | { client_id?: string; scope?: string }
    },
  ) => Promise<void>
}) {
  const [state, setState] = createStore({
    name: props.existing?.name ?? "",
    url: props.existing?.url ?? "",
    auth: props.existing ? "keep" : "auto",
    clientID: "",
    scope: "",
    busy: false,
    error: "",
  })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()

    if (state.busy) return
    const name = state.name.trim()
    const url = state.url.trim()

    if (!name) return setState("error", props.translate("mcp.connection.nameRequired"))

    if (!props.existing && props.names.includes(name))
      return setState("error", props.translate("mcp.connection.duplicate"))

    if (
      !URL.canParse(url) ||
      !["http:", "https:"].includes(new URL(url).protocol) ||
      new URL(url).username ||
      new URL(url).password
    )
      return setState("error", props.translate("mcp.connection.invalidURL"))
    setState({ busy: true, error: "" })

    try {
      const config: Parameters<typeof props.save>[1] = {
        type: "remote",
        url,
        disabled: false,
      }

      if (state.auth === "none") config.oauth = false

      if (state.auth === "auto") {
        config.oauth = {}

        if (state.clientID.trim()) config.oauth.client_id = state.clientID.trim()

        if (state.scope.trim()) config.oauth.scope = state.scope.trim()
      }

      await props.save(name, config)
      props.close()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : props.translate("common.requestFailed"))
    } finally {
      setState("busy", false)
    }
  }

  return (
    <Dialog fit containerClass="max-h-[calc(100dvh-48px)] max-w-[calc(100vw-32px)]" class="!overflow-hidden">
      <DialogHeader>
        <DialogTitle>{props.translate(props.existing ? "mcp.connection.edit" : "mcp.connection.add")}</DialogTitle>
      </DialogHeader>
      <form class="flex min-h-0 w-full flex-1 flex-col overflow-hidden" onSubmit={submit}>
        <DialogBody class="!overflow-y-auto">
          <div class="flex flex-col gap-5 px-5 pb-4 text-13-regular">
            <p class="text-v2-text-text-muted">{props.translate("mcp.connection.description")}</p>
            <label class="flex flex-col gap-2">
              <span>{props.translate("mcp.connection.name")}</span>
              <TextInput
                class="!w-full min-w-0"
                value={state.name}
                onInput={(event) => setState("name", event.currentTarget.value)}
                disabled={state.busy || !!props.existing}
                autofocus={!props.existing}
                autocomplete="off"
              />
            </label>
            <label class="flex flex-col gap-2">
              <span>{props.translate("mcp.connection.url")}</span>
              <TextInput
                class="!w-full min-w-0"
                value={state.url}
                onInput={(event) => setState("url", event.currentTarget.value)}
                disabled={state.busy}
                autofocus={!!props.existing}
                placeholder="https://example.com/mcp"
                autocomplete="off"
                spellcheck={false}
              />
            </label>
            <label class="flex flex-col gap-2">
              <span>{props.translate("mcp.connection.authentication")}</span>
              <select
                aria-label={props.translate("mcp.connection.authentication")}
                class="h-9 min-w-0 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2"
                value={state.auth}
                onChange={(event) => setState("auth", event.currentTarget.value)}
                disabled={state.busy}
              >
                <Show when={props.existing}>
                  <option value="keep">{props.translate("mcp.connection.auth.keep")}</option>
                </Show>
                <option value="auto">{props.translate("mcp.connection.auth.auto")}</option>
                <option value="none">{props.translate("mcp.connection.auth.none")}</option>
              </select>
            </label>
            <Show when={state.auth === "auto"}>
              <details>
                <summary class="cursor-pointer text-v2-text-text-muted">
                  {props.translate("mcp.connection.advanced")}
                </summary>
                <div class="mt-4 flex flex-col gap-4">
                  <p class="text-v2-text-text-muted">{props.translate("mcp.connection.registrationHint")}</p>
                  <label class="flex flex-col gap-2">
                    <span>{props.translate("mcp.connection.clientID")}</span>
                    <TextInput
                      class="!w-full min-w-0"
                      value={state.clientID}
                      onInput={(event) => setState("clientID", event.currentTarget.value)}
                      disabled={state.busy}
                      autocomplete="off"
                    />
                  </label>
                  <label class="flex flex-col gap-2">
                    <span>{props.translate("mcp.connection.scope")}</span>
                    <TextInput
                      class="!w-full min-w-0"
                      value={state.scope}
                      onInput={(event) => setState("scope", event.currentTarget.value)}
                      disabled={state.busy}
                      autocomplete="off"
                    />
                  </label>
                </div>
              </details>
            </Show>
            <Show when={state.error}>
              <p role="alert" class="text-v2-text-text-feedback-error">
                {state.error}
              </p>
            </Show>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={state.busy} onClick={() => props.close()}>
            {props.translate("common.cancel")}
          </Button>
          <Button type="submit" disabled={state.busy}>
            {props.translate(state.busy ? "mcp.connection.saving" : "mcp.connection.saveConnect")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
