/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { resolveThemeDocument } from "@opencode/theme/tui"
import { ConfigProvider, useConfig, type Info } from "../../src/config"
import { ThemeProvider, useTheme, useThemes } from "../../src/context/theme"
import { getOpenCode2Theme, getOpenCodeTheme } from "../../src/theme"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test.each([undefined, "opencode", "system"])("Silver is the default while preserving saved theme %s", async (name) => {
  await using temporary = await tmpdir()
  let settings: Info = name ? { theme: { name, mode: "light" } } : {}
  let config!: ReturnType<typeof useConfig>
  let themes!: ReturnType<typeof useThemes>
  function Probe() {
    config = useConfig()
    themes = useThemes()
    return null
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: temporary.path }}>
      <ConfigProvider
        config={createTuiResolvedConfig(settings)}
        service={{
          get: async () => settings,
          update: async (mutate) => {
            const next = structuredClone(settings)
            mutate(next)
            settings = next
            return next
          },
        }}
      >
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    </TestTuiContexts>
  ))
  try {
    app.renderer.start()
    await app.waitForFrame(() => themes?.ready === true)
    expect(themes.selected).toBe(name ?? "silver")
    expect(themes.has("silver")).toBeTrue()
    expect(themes.mode()).toBe(name ? "light" : "dark")
    expect(themes.set("silver")).toBeTrue()
    await app.waitForFrame(() => config.data.theme?.name === "silver")
    expect(themes.supports("light")).toBeTrue()
    expect(themes.supports("dark")).toBeTrue()
    expect(themes.setMode("dark")).toBeTrue()
    await app.waitForFrame(() => config.data.theme?.mode === "dark")
    expect(themes.currentTokens().background.base.toInts().slice(0, 3)).toEqual([20, 20, 20])
  } finally {
    app.renderer.destroy()
  }
})

test("offers opencode2 only while the new designs experiment is enabled", async () => {
  await using temporary = await tmpdir()
  const settings: Info = {}
  let config!: ReturnType<typeof useConfig>
  let themes!: ReturnType<typeof useThemes>
  let theme!: ReturnType<typeof useTheme>
  function Probe() {
    config = useConfig()
    themes = useThemes()
    theme = useTheme()
    return null
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: temporary.path }}>
      <ConfigProvider
        config={createTuiResolvedConfig(settings)}
        service={{
          get: async () => settings,
          update: async (update) => {
            update(settings)
            return settings
          },
        }}
      >
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    </TestTuiContexts>
  ))

  try {
    app.renderer.start()
    await app.waitForFrame(() => themes !== undefined)
    expect(themes.has("opencode2")).toBeFalse()
    expect(Object.keys(themes.all())).not.toContain("opencode2")
    expect(themes.set("opencode2")).toBeFalse()

    await config.update((draft) => {
      draft.experimental = { "new-designs": true }
    })
    expect(themes.has("opencode2")).toBeTrue()
    expect(themes.set("opencode2")).toBeTrue()
    expect(theme.background.base.equals(resolveThemeDocument(getOpenCode2Theme(), "dark").background.base)).toBeTrue()

    await config.update((draft) => {
      draft.experimental = { "new-designs": false }
    })
    expect(themes.has("opencode2")).toBeFalse()
    expect(theme.background.base.equals(resolveThemeDocument(getOpenCodeTheme(), "dark").background.base)).toBeTrue()
    expect(themes.selected).toBe("opencode2")
    expect(settings.theme?.name).toBe("opencode2")
  } finally {
    app.renderer.destroy()
  }
})
