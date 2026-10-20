import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { globalExtensionSources, type JsonValue } from "@opencode/client"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"

export function DialogExtensionSource(props: { kind: "plugin" | "skill"; onBack: () => void }) {
  const client = useClient()
  const theme = useTheme().surface("dialog")
  const toast = useToast()
  const [state, setState] = createStore({ step: "source", source: "", options: "{}", busy: false, error: "" })
  const submit = async (value: string) => {
    if (state.busy) return
    const text = value.trim()
    if (state.step === "options") setState("options", value)
    if (state.step === "source") {
      if (!text) return setState("error", "Enter a package, folder or source URL.")
      if (
        props.kind === "skill" &&
        /^[a-z]+:\/\//i.test(text) &&
        (!URL.canParse(text) ||
          !["http:", "https:"].includes(new URL(text).protocol) ||
          new URL(text).username ||
          new URL(text).password)
      )
        return setState(
          "error",
          "Enter a folder path or an HTTP or HTTPS skill collection URL without embedded credentials.",
        )
      setState({ source: text, error: "" })
      if (props.kind === "plugin") return setState("step", "options")
    }
    const source = state.source
    const options = (() => {
      if (props.kind !== "plugin") return {}
      try {
        const parsed: JsonValue = JSON.parse(text || "{}")
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
      } catch {
        /* Keep invalid JSON in the prompt for correction. */
      }
      return undefined
    })()
    if (!options) {
      setState("options", value)
      return setState("error", "Plugin settings must be a valid JSON object.")
    }
    setState({ busy: true, error: "" })
    try {
      const configured = globalExtensionSources(await client.api.config.get())
      if (props.kind === "plugin" ? configured.plugins.has(source) : configured.skills.includes(source))
        throw new Error("This source is already configured.")
      await client.api.config.update(
        props.kind === "plugin" ? { plugins: { [source]: options } } : { skills: { [source]: true } },
      )
      toast.show({
        variant: "success",
        message: "Source saved. Check the inventory for available plugins and skills or load errors.",
      })
      props.onBack()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <Show when={state.step} keyed>
      {(step) => (
        <DialogPrompt
          title={step === "options" ? "Plugin settings" : props.kind === "plugin" ? "Add plugin" : "Add skill"}
          subtitle={
            state.step === "options"
              ? "Plugin settings · JSON object"
              : props.kind === "plugin"
                ? "Package or local plugin folder · all projects"
                : "Folder on this server or skill collection URL · all projects"
          }
          placeholder={
            state.step === "options"
              ? "{}"
              : props.kind === "plugin"
                ? "package-name or /path/to/plugin-folder"
                : "~/skills or https://example.com/skills/"
          }
          value={state.step === "options" ? state.options : state.source}
          busy={state.busy}
          busyText="Saving source…"
          description={() => (
            <box flexDirection="column">
              <Show when={props.kind === "skill"}>
                <text fg={theme.text.muted}>Collection URLs must provide index.json and skill files.</text>
              </Show>
              <Show when={state.error}>
                <text fg={theme.text.feedback.error.base}>{state.error}</text>
              </Show>
            </box>
          )}
          onConfirm={(value) => void submit(value)}
          onCancel={() => (state.step === "options" ? setState({ step: "source", error: "" }) : props.onBack())}
        />
      )}
    </Show>
  )
}
