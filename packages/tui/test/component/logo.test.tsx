/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Logo } from "../../src/component/logo"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { go, logo } from "../../src/logo"

test.each([100, 44, 26, 20])("the original Subi Code lettering fits a %s-column terminal", async (width) => {
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
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(3)
    expect(frame.split("\n").every((line) => Array.from(line.trimEnd()).length <= width)).toBe(true)
    if (width >= 50) {
      expect(
        frame
          .split("\n")
          .slice(0, 5)
          .map((line) => line.trimEnd()),
      ).toEqual(logo.left.map((line, index) => `${line} ${logo.right[index]}`.trimEnd()))
    } else if (width >= 26) expect(frame).toContain("SUBI CODE")
    else expect(frame).toContain(go.right[1].trimEnd())
  } finally {
    app.renderer.destroy()
  }
})
