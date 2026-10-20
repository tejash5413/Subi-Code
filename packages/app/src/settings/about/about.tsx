import { useDialog } from "@opencode/ui/context/dialog"
import { Mark } from "@opencode/ui/logo"
import { Button } from "@opencode/ui/button"
import { Product } from "@opencode/util/product"
import { useLanguage } from "@/runtime/i18n/language"
import { ExternalLink } from "@/runtime/platform/external-link"
import { showToast } from "@/shell/notifications/toast"
import { SettingsList } from "../list"
import { SettingsRow } from "../row"

export function SettingsAbout() {
  const language = useLanguage()
  const dialog = useDialog()

  const showNotices = async () => {
    const loaded = await import("./notices/dialog").catch(() => undefined)

    if (!loaded) {
      showToast({ variant: "error", title: language.t("settings.about.notices.loadFailed") })

      return
    }

    void dialog.show(() => <loaded.default />)
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.about")}</h2>
            <span class="text-13-regular text-v2-text-text-muted">
              {language.t("settings.about.installationDescription")}
            </span>
          </div>
        </div>
      </div>
      <div class="settings-tab-body">
        <div class="settings-about-brand">
          <Mark class="settings-about-mark" aria-hidden="true" />
          <div>
            <strong>{language.t("workspace.brand")}</strong>
            <p>{language.t("settings.about.subi.description")}</p>
          </div>
        </div>
        <section class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.about.installation")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.about.versionLabel")}
              description={language.t("settings.about.version", {
                version: Product.version,
              })}
            >
              <span class="settings-version">{Product.version}</span>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.about.websiteLabel")}
              description={language.t("settings.about.subi.website")}
            >
              <ExternalLink class="settings-action-link" href={Product.website}>
                {language.t("settings.about.subi.website")}
              </ExternalLink>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.about.documentationLabel")}
              description={language.t("settings.about.documentationDescription")}
            >
              <ExternalLink class="settings-action-link" href={Product.documentation}>
                {language.t("settings.about.documentationAction")}
              </ExternalLink>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.about.supportLabel")}
              description={language.t("settings.about.supportDescription")}
            >
              <ExternalLink class="settings-action-link" href={Product.support}>
                {language.t("settings.about.subi.support")}
              </ExternalLink>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.about.notices.title")}
              description={language.t("settings.about.noticesDescription")}
            >
              <Button variant="outline" onClick={() => void showNotices()}>
                {language.t("settings.about.notices.title")}
              </Button>
            </SettingsRow>
          </SettingsList>
        </section>
        <p class="settings-about-license">{language.t("settings.about.subi.license")}</p>
      </div>
    </>
  )
}
