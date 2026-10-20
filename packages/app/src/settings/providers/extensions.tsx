import { Component } from "solid-js"
import { Tabs } from "@opencode/ui/tabs"
import { Product } from "@opencode/util/product"
import { useLanguage } from "@/runtime/i18n/language"
import { ExternalLink } from "@/runtime/platform/external-link"
import type { SettingsView } from "@/settings/surface"
import "@/settings/settings.css"
import { ExtensionSources } from "./extension-sources"
import { McpConnections } from "./mcp-connections"

export const SettingsExtensions: Component<{
  subtab?: SettingsView["subtab"]
  onSubtab: (value: SettingsView["subtab"]) => void
}> = (props) => {
  const language = useLanguage()
  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.extensions")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.extensions.description")}</span>
          </div>
          <ExternalLink
            class="settings-action-link"
            href={
              props.subtab === "plugins"
                ? Product.guides.plugins
                : props.subtab === "skills"
                  ? Product.guides.skills
                  : Product.guides.mcp
            }
          >
            {language.t("common.learnMore")}
          </ExternalLink>
        </div>
      </div>

      <div class="settings-tab-body">
        <Tabs
          variant="pill"
          value={props.subtab ?? "mcps"}
          onChange={(value) => {
            if (value === "mcps" || value === "plugins" || value === "skills") props.onSubtab(value)
          }}
          class="settings-extensions-tabs settings-subtabs"
        >
          <Tabs.List>
            <Tabs.Trigger value="mcps">{language.t("settings.extensions.tab.mcps")}</Tabs.Trigger>
            <Tabs.Trigger value="plugins">{language.t("settings.extensions.tab.plugins")}</Tabs.Trigger>
            <Tabs.Trigger value="skills">{language.t("settings.extensions.tab.skills")}</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="mcps">
            <McpConnections />
          </Tabs.Content>

          <Tabs.Content value="plugins">
            <ExtensionSources kind="plugin" />
          </Tabs.Content>
          <Tabs.Content value="skills">
            <ExtensionSources kind="skill" />
          </Tabs.Content>
        </Tabs>
      </div>
    </>
  )
}
