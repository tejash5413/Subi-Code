import { For } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode/ui/icon"
import { Mark } from "@opencode/ui/logo"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { useSettingsSurface } from "@/settings/surface"
import type { SettingsRootTab } from "@/settings/route"

export function WorkspaceSidebar(props: { mount: (element: HTMLElement) => void }) {
  const language = useLanguage()
  const command = useCommand()
  const layout = useLayout()
  const tabs = useTabs()
  const settings = useSettingsSurface()
  const navigate = useNavigate()
  const links = [
    { tab: "models", label: "workspace.nav.models", icon: "window-analytics" },
    { tab: "providers", label: "workspace.nav.integrations", icon: "globe" },
    { tab: "extensions", label: "workspace.nav.extensions", icon: "grid-plus" },
  ] as const satisfies readonly { tab: SettingsRootTab; label: string; icon: string }[]

  return (
    <aside class="subi-workspace-sidebar" aria-label={language.t("workspace.navigation")}>
      <div class="subi-workspace-brand">
        <Mark class="size-8 shrink-0" aria-hidden="true" />
        <span>{language.t("workspace.brand")}</span>
      </div>
      <button class="subi-new-task" type="button" onClick={() => command.trigger("tab.new")}>
        <Icon name="plus" />
        <span>{language.t("workspace.newTask")}</span>
        <kbd>{command.keybind("tab.new")}</kbd>
      </button>
      <nav class="subi-workspace-nav">
        <button
          type="button"
          aria-current={layout.route().type === "draft" || layout.route().type === "session" ? "page" : undefined}
          onClick={() => {
            if (settings.active()) return settings.close()
            if (layout.route().type === "draft" || layout.route().type === "session") return
            const tab = tabs.store.at(-1)
            if (tab) return tabs.select(tab)
            command.trigger("tab.new")
          }}
        >
          <Icon name="workspace" />
          {language.t("workspace.nav.workspace")}
        </button>
        <button
          type="button"
          aria-current={layout.route().type === "home" ? "page" : undefined}
          onClick={() => navigate("/")}
        >
          <Icon name="archive" />
          {language.t("workspace.nav.recent")}
        </button>
        <For each={links}>
          {(link) => (
            <button
              type="button"
              aria-current={settings.active() && settings.view().tab === link.tab ? "page" : undefined}
              onClick={() => settings.open(link.tab)}
            >
              <Icon name={link.icon} />
              {language.t(link.label)}
            </button>
          )}
        </For>
      </nav>
      <div class="subi-workspace-tasks-label">{language.t("workspace.openTasks")}</div>
      <div ref={props.mount} class="subi-workspace-tasks" />
      <div class="subi-workspace-account">
        <button type="button" onClick={() => settings.open("providers")}>
          <Icon name="graduation-cap" />
          <span>
            <strong>{language.t("workspace.learnsmart")}</strong>
            <small>{language.t("workspace.accountCredits")}</small>
          </span>
        </button>
        <button type="button" aria-label={language.t("sidebar.settings")} onClick={() => settings.open()}>
          <Icon name="settings-gear" />
        </button>
      </div>
    </aside>
  )
}
