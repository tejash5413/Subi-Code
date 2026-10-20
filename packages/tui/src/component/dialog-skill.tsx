import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createResource, createMemo, createSignal, Match, Switch } from "solid-js"
import { DIALOG_LIST_INSET, useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { DialogExtensionSource } from "./dialog-extension-source"
import { useData } from "../context/data"
import type { LocationRef } from "@opencode/client"

export type DialogSkillProps = {
  location?: LocationRef
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const data = useData()
  const theme = useTheme()
  dialog.setSize("large")

  const [adding, setAdding] = createSignal(false)
  const [loadError, setLoadError] = createSignal<unknown>()

  const [skills, { refetch }] = createResource(() =>
    Promise.resolve()
      .then(async () => {
        const current = data.location.skill.list(props.location)
        if (current) return current
        await data.location.skill.sync(props.location)
        return data.location.skill.list(props.location) ?? []
      })
      // Catch so the rejected resource never reaches the memo below: reading
      // skills() in an errored state re-throws and tears down the dialog.
      .catch((error) => {
        setLoadError(error)
        return undefined
      }),
  )

  const showError = createMemo(() => Boolean(loadError()))

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (showError()) return []
    const list = data.location.skill.list(props.location) ?? skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => ({
      title: skill.name.padEnd(maxWidth),
      description: skill.description?.replace(/\s+/g, " ").trim(),
      value: skill.id,
      onSelect: () => {
        props.onSelect(skill.id)
        dialog.clear()
      },
    }))
  })

  return (
    <Switch
      fallback={
        <DialogExtensionSource
          kind="skill"
          onBack={() => {
            setAdding(false)
            data.location.skill.invalidate(props.location)
            setLoadError(undefined)
            void refetch()
          }}
        />
      }
    >
      <Match when={!adding()}>
        <DialogSelect
          title="Skills"
          options={options()}
          actions={[
            {
              title: "add skill",
              command: "dialog.skills.add",
              bind: "ctrl+a",
              selection: "none",
              onTrigger: () => setAdding(true),
            },
          ]}
          renderFilter={!showError() && !skills.loading}
          locked={showError() || skills.loading}
          emptyView={
            <Switch
              fallback={
                <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
                  <text fg={theme.text.muted}>No skills available</text>
                </box>
              }
            >
              <Match when={showError()}>
                <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
                  <text fg={theme.text.feedback.error.base} attributes={TextAttributes.BOLD}>
                    Could not load skills
                  </text>
                  <text fg={theme.text.muted}>{errorMessage(loadError())}</text>
                  <text fg={theme.text.muted}>Close and reopen Skills to try again.</text>
                </box>
              </Match>
              <Match when={skills.loading}>
                <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
                  <text fg={theme.text.muted}>Loading skills…</text>
                </box>
              </Match>
            </Switch>
          }
          noMatchView={
            <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
              <text fg={theme.text.muted}>No skills found</text>
            </box>
          }
        />
      </Match>
    </Switch>
  )
}
