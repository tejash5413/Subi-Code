import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ErrorComponent } from "../../src/component/error-component"
import { ExitProvider } from "../../src/context/exit"
import { TuiAppProvider } from "../../src/context/runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

test("crash report uses Subi Code identity and copies local report text", async () => {
  let copied = ""
  const app = await testRender(
    () => (
      <TestTuiContexts
        clipboard={{
          read: async () => undefined,
          write: async (text) => {
            copied = text
          },
        }}
      >
        <TuiAppProvider value={{ name: "subi", version: "2.0.0", channel: "dev" }}>
          <ExitProvider exit={() => {}}>
            <ErrorComponent error={new Error("Fixture coding failure")} reset={() => {}} />
          </ExitProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  try {
    await app.renderOnce()
    app.mockInput.pressKey("c")
    await app.waitFor(() => copied.length > 0)
    expect(copied).toStartWith("Subi Code 2.0.0")
    expect(copied).toContain("Fixture coding failure")
    expect(copied).toContain("Stack trace:")
    expect(copied).not.toContain("github.com/anomalyco/opencode")
    expect(app.captureCharFrame()).toContain("Subi Code crashed")
  } finally {
    app.renderer.destroy()
  }
})
