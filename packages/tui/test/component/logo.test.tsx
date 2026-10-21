/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Logo } from "../../src/component/logo"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { wordmark } from "../../src/logo"

test.each([100, 44, 26, 20])("SubiCode wordmark fits a %s-column terminal without a separate icon", async (width) => {
  await using temporary = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Logo />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    const frame = await app.waitForFrame((frame) => frame.trim().length > 0)
    const spans = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.text.trim())
    expect(new Set(spans.map((span) => span.fg.toInts().join(","))).size).toBe(1)
    const channels = spans[0]!.fg.toInts().slice(0, 3)
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(10)
    expect(frame.split("\n").every((line) => Array.from(line.trimEnd()).length <= width)).toBe(true)
    if (width >= wordmark[0].length + 4) {
      expect(
        frame
          .split("\n")
          .slice(0, 5)
          .map((line) => line.trim()),
      ).toEqual(wordmark.map((line) => line.trim()))
    } else expect(frame).toContain("SubiCode")
  } finally {
    app.renderer.destroy()
  }
})
