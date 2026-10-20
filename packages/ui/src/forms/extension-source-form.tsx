import type { JsonValue } from "@opencode/client"
import type { Key } from "../i18n/en"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "../actions/button/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../overlays/dialog/dialog"
import { TextInput } from "./text-input/text-input"
import { Textarea } from "./textarea/textarea"

export type ExtensionSourceKind = "plugin" | "skill"
export type ExtensionSourceFormKey = Extract<Key, `extensions.${string}`> | "common.cancel" | "common.requestFailed"

export function ExtensionSourceForm(props: {
  kind: ExtensionSourceKind
  existing?: { source: string; options?: Record<string, unknown> }
  sources: string[]
  translate: (key: ExtensionSourceFormKey) => string
  save: (source: string, options: Record<string, JsonValue>) => Promise<void>
  close: () => void
}) {
  const [state, setState] = createStore({
    source: props.existing?.source ?? "",
    options: JSON.stringify(props.existing?.options ?? {}, null, 2),
    type: /^https?:\/\//i.test(props.existing?.source ?? "") ? "url" : "folder",
    busy: false,
    error: "",
  })
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.busy) return
    const source = state.source.trim()
    if (!source) return setState("error", props.translate("extensions.source.required"))
    if (source !== props.existing?.source && props.sources.includes(source))
      return setState("error", props.translate("extensions.source.duplicate"))
    if (
      props.kind === "skill" &&
      state.type === "url" &&
      (!URL.canParse(source) ||
        !["http:", "https:"].includes(new URL(source).protocol) ||
        new URL(source).username ||
        new URL(source).password)
    )
      return setState("error", props.translate("extensions.source.invalidURL"))
    if (props.kind === "skill" && state.type === "folder" && /^[a-z]+:\/\//i.test(source))
      return setState("error", props.translate("extensions.source.invalidFolder"))
    const options = (() => {
      if (props.kind !== "plugin") return {}
      try {
        const value: JsonValue = JSON.parse(state.options || "{}")
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(Object.entries(value))
      } catch {
        /* The field error below keeps the user's input for correction. */
      }
      return undefined
    })()
    if (!options) return setState("error", props.translate("extensions.source.invalidOptions"))
    setState({ busy: true, error: "" })
    try {
      await props.save(source, options)
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
        <DialogTitle>{props.translate(`extensions.${props.kind}.${props.existing ? "edit" : "add"}`)}</DialogTitle>
      </DialogHeader>
      <form class="flex min-h-0 w-full flex-1 flex-col overflow-hidden" onSubmit={submit}>
        <DialogBody class="!overflow-y-auto">
          <div class="flex flex-col gap-5 px-5 pb-4 text-13-regular">
            <p class="text-v2-text-text-muted">{props.translate(`extensions.${props.kind}.description`)}</p>
            <Show when={props.kind === "skill"}>
              <label class="flex flex-col gap-2">
                <span>{props.translate("extensions.skill.type")}</span>
                <select
                  aria-label={props.translate("extensions.skill.type")}
                  class="h-9 min-w-0 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2"
                  value={state.type}
                  onChange={(event) => setState("type", event.currentTarget.value)}
                  disabled={state.busy}
                >
                  <option value="folder">{props.translate("extensions.skill.folder")}</option>
                  <option value="url">{props.translate("extensions.skill.url")}</option>
                </select>
              </label>
            </Show>
            <label class="flex flex-col gap-2">
              <span>
                {props.translate(
                  props.kind === "plugin"
                    ? "extensions.plugin.source"
                    : state.type === "url"
                      ? "extensions.skill.url"
                      : "extensions.skill.folder",
                )}
              </span>
              <TextInput
                class="!w-full min-w-0"
                value={state.source}
                onInput={(event) => setState("source", event.currentTarget.value)}
                disabled={state.busy || (props.kind === "plugin" && !!props.existing)}
                autofocus
                autocomplete="off"
                spellcheck={false}
                placeholder={props.translate(
                  props.kind === "plugin"
                    ? "extensions.plugin.placeholder"
                    : state.type === "url"
                      ? "extensions.skill.urlPlaceholder"
                      : "extensions.skill.folderPlaceholder",
                )}
              />
            </label>
            <Show when={props.kind === "skill" && state.type === "url"}>
              <p class="text-v2-text-text-muted">{props.translate("extensions.skill.urlHint")}</p>
            </Show>
            <Show when={props.kind === "plugin"}>
              <label class="flex flex-col gap-2">
                <span>{props.translate("extensions.plugin.options")}</span>
                <Textarea
                  class="!w-full min-w-0"
                  aria-label={props.translate("extensions.plugin.options")}
                  value={state.options}
                  onInput={(event) => setState("options", event.currentTarget.value)}
                  disabled={state.busy}
                  rows={5}
                  spellcheck={false}
                />
                <span class="text-v2-text-text-muted">{props.translate("extensions.plugin.optionsHint")}</span>
              </label>
            </Show>
            <Show when={state.error}>
              <p role="alert" class="text-v2-text-text-feedback-error">
                {state.error}
              </p>
            </Show>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={state.busy} onClick={props.close}>
            {props.translate("common.cancel")}
          </Button>
          <Button type="submit" disabled={state.busy}>
            {props.translate(state.busy ? "extensions.source.saving" : "extensions.source.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
