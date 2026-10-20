/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogSkill } from "../../../src/component/dialog-skill"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createFetch, json } from "../../fixture/tui-client"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("adds a skill folder from an empty inventory and preserves the prompt when a save fails", async () => {
  const updates: unknown[] = []
  const transport = createFetch(async (url, request) => {
    if (url.pathname === "/api/skill")
      return json({
        location: {
          directory: process.cwd(),
          project: { id: "proj_test", directory: process.cwd(), canonical: process.cwd() },
        },
        data: [],
      })
    if (url.pathname === "/api/config") return json([])
    if (url.pathname === "/api/experimental/config" && request.method === "PATCH") {
      updates.push(await request.json())
      return updates.length === 1 ? new Response("Save failed", { status: 503 }) : new Response(null, { status: 204 })
    }
  })
  function Probe() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSkill
          onSelect={() => {
            throw new Error("Should not select a skill while adding a source")
          }}
        />
      )),
    )
    return null
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ClientProvider api={createApi(transport.fetch)}>
                <DataProvider directory={process.cwd()}>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <DialogProvider>
                      <Probe />
                    </DialogProvider>
                  </ThemeProvider>
                </DataProvider>
              </ClientProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("No skills available") && frame.includes("add skill"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame(
      (frame) => frame.includes("Add skill") && app.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )
    await app.mockInput.typeText("file:///skills")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("HTTP or HTTPS"))
    expect(updates).toEqual([])
    const input = app.renderer.currentFocusedRenderable
    if (!(input instanceof TextareaRenderable)) throw new Error("Expected skill source input")
    input.setText("~/skills")
    app.mockInput.pressEnter()
    await app.waitForFrame(
      (frame) =>
        frame.includes("Add skill") &&
        frame.includes("~/skills") &&
        app.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )
    await app.waitFor(() => updates.length === 1)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("No skills available"))
    expect(updates).toEqual([{ skills: { "~/skills": true } }, { skills: { "~/skills": true } }])
  } finally {
    app.renderer.destroy()
  }
})
