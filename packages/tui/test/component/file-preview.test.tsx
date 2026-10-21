/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ScrollBoxRenderable } from "@opentui/core"
import { FilePreview } from "../../src/component/file-preview"
import { SidebarSection } from "../../src/routes/session/sidebar-section"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { tmpdir, emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test.each([44, 100])(
  "1000-line previews expand, scroll and collapse without taking over a %s-column terminal",
  async (width) => {
    await using temporary = await tmpdir()
    const content = Array.from({ length: 1000 }, (_, i) => `Source line ${String(i + 1).padStart(4, "0")}`).join("\n")
    const app = await testRender(
      () => (
        <TestTuiContexts paths={{ state: temporary.path, home: temporary.path }}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <FilePreview lines={1000}>
                <text>{content}</text>
              </FilePreview>
              <text>Conversation continues here</text>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 40, kittyKeyboard: true },
    )
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("▼ Expand"))
      expect(app.captureCharFrame()).toContain("▼ Expand")
      expect(app.captureCharFrame()).toContain("Source line 0008")
      expect(app.captureCharFrame()).not.toContain("Source line 0009")
      expect(app.captureCharFrame()).toContain("Conversation continues here")
      await app.mockMouse.click(3, 0)
      await app.waitForFrame((frame) => frame.includes("▲ Collapse") && frame.includes("Source line 0020"))
      expect(app.captureCharFrame()).toContain("▲ Collapse")
      expect(app.captureCharFrame()).toContain("Source line 0020")
      const scroll = app.renderer.root
        .getChildren()
        .flatMap((node) => node.getChildren())
        .find((node) => node instanceof ScrollBoxRenderable)
      expect(scroll).toBeDefined()
      if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Preview scroll container missing")
      await app.mockMouse.scroll(scroll.viewport.x + 3, scroll.viewport.y + 3, "down")
      await app.waitForFrame((frame) => frame.includes("Source line 0021"))
      expect(app.captureCharFrame()).toContain("Conversation continues here")
      scroll.scrollTo({ x: 0, y: 1000 })
      await app.waitForFrame((frame) => frame.includes("Source line 1000"))
      expect(app.captureCharFrame()).toContain("Source line 1000")
      expect(app.captureCharFrame()).toContain("Conversation continues here")
      app.renderer.clearSelection()
      await app.mockMouse.click(7, 0)
      await app.waitForFrame((frame) => frame.includes("▼ Expand") && frame.includes("Source line 0008"))
      expect(app.captureCharFrame()).toContain("▼ Expand")
      expect(scroll.height).toBe(8)
    } finally {
      app.renderer.destroy()
    }
  },
)

test("sidebar sections scroll independently and collapse to a single heading", async () => {
  await using temporary = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path, home: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <SidebarSection title="Changes" rows={50}>
              <text>{Array.from({ length: 50 }, (_, i) => `Created file-${i + 1}.ts`).join("\n")}</text>
            </SidebarSection>
            <text>Context and balance remain visible</text>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 42, height: 24, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Created file-8.ts"))
    expect(app.captureCharFrame()).toContain("Created file-8.ts")
    expect(app.captureCharFrame()).not.toContain("Created file-9.ts")
    expect(app.captureCharFrame()).toContain("Context and balance remain visible")
    await app.mockMouse.scroll(3, 4, "down")
    await app.waitForFrame((frame) => frame.includes("Created file-9.ts"))
    expect(app.captureCharFrame()).toContain("Context and balance remain visible")
    await app.mockMouse.click(3, 0)
    await app.waitForFrame((frame) => frame.includes("Changes") && !frame.includes("Created file-1.ts"))
    expect(app.captureCharFrame()).not.toContain("Created file-1.ts")
    expect(app.captureCharFrame()).toContain("Changes")
    expect(app.captureCharFrame()).toContain("Context and balance remain visible")
  } finally {
    app.renderer.destroy()
  }
})
