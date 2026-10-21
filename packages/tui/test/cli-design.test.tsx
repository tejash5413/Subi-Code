import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { wordmark } from "../src/logo"
import { json } from "./fixture/tui-client"

test.each([
  { width: 100, height: 30 },
  { width: 44, height: 30 },
  { width: 32, height: 26 },
  { width: 44, height: 18 },
])("CLI welcome keeps its editor visible at $width × $height", async ({ width, height }) => {
  await using setup = await createAppFixture({ width, height })
  await setup.ready
  await setup.waitForFrame(
    (frame) => frame.includes("2.0.1") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  const input = setup.renderer.currentFocusedRenderable
  if (!(input instanceof TextareaRenderable)) throw new Error("Prompt is not focused")
  if (input.plainText) await setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Ask Subi anything"))
  expect(input.x).toBeGreaterThanOrEqual(0)
  expect(input.x + input.width).toBeLessThanOrEqual(width)
  expect(input.y + input.height).toBeLessThanOrEqual(height)
  const frame = setup.captureCharFrame()
  expect(frame).toContain("2.0.1")
  if (height >= 20) {
    if (width >= wordmark[0].length + 4 && height >= 26) expect(frame).toContain(wordmark[0].trim())
    else expect(frame).toContain("SubiCode")
    expect(frame).toContain("paste")
    expect(frame).toContain("history")
    if (width < 44) expect(frame).toContain("ctrl+p menu")
  }
  try {
    await setup.mockInput.typeText("abc")
    await setup.mockInput.pressArrow("left")
    await setup.mockInput.typeText("X")
    expect(input.plainText).toBe("abXc")
  } finally {
    await setup.mockInput.pressKey("c", { ctrl: true })
    await setup.waitForFrame(() => input.plainText === "")
  }
})

test("CLI hints follow remapped bindings without changing a saved theme", async () => {
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: {
      animations: false,
      theme: { name: "carbonfox", mode: "light" },
      keybinds: { "model.list": "ctrl+g", "agent.cycle": "ctrl+k" },
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("ctrl+g models") && frame.includes("ctrl+k agent"))
  expect(setup.config().theme).toEqual({ name: "carbonfox", mode: "light" })
  expect(setup.captureCharFrame()).not.toContain("ctrl+x m models")
  const input = setup.renderer.currentFocusedRenderable
  if (!(input instanceof TextareaRenderable)) throw new Error("Prompt is not focused")
  if (input.plainText) await setup.mockInput.pressKey("c", { ctrl: true })
  try {
    await setup.mockInput.pasteBracketedText("clipboard text")
    await setup.waitForFrame(() => input.plainText === "clipboard text")
    expect(input.plainText).toBe("clipboard text")
  } finally {
    await setup.mockInput.pressKey("c", { ctrl: true })
    await setup.waitForFrame(() => input.plainText === "")
  }
})

test("welcome wordmark stays while typing, leaves on send, and returns for a fresh session", async () => {
  const directory = process.cwd()
  const location = { directory, project: { id: "preview", directory, canonical: directory } }
  let session: unknown
  let submitted = 0
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { mode: "off" }, keybinds: { "session.new": "f6" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "sample", name: "Sample" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "sample", providerID: "sample", name: "Sample model", variants: [] }] })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const input: unknown = await request.json()
        if (typeof input !== "object" || input === null) throw new Error("Expected a session input")
        session = {
          ...input,
          projectID: "preview",
          title: "Welcome lifecycle",
          location,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        }
        return json({ data: session })
      }
      if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        submitted++
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (session && /^\/api\/session\/[^/]+$/.test(url.pathname)) return json({ data: session })
    },
  })
  await setup.ready
  await setup.waitForFrame(
    (frame) =>
      frame.includes(wordmark[0].trim()) &&
      frame.includes("Build · Sample model") &&
      setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  const first = setup
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes(wordmark[2].trim()))!
  const width = wordmark[2].trim().length
  expect(Math.abs(first.indexOf(wordmark[2].trim()) + width / 2 - 50)).toBeLessThanOrEqual(1)
  await setup.mockInput.typeText("Check the welcome screen")
  expect(setup.renderer.root.findDescendantById("welcome-wordmark")).toBeDefined()
  expect(submitted).toBe(0)
  await setup.mockInput.pressEnter()
  await setup.waitForFrame(() => submitted === 1 && !setup.renderer.root.findDescendantById("welcome-wordmark"))
  expect(setup.captureCharFrame()).not.toContain(wordmark[0].trim())
  await setup.mockInput.pressKey("F6")
  await setup.waitForFrame(
    (frame) =>
      frame.includes(wordmark[0].trim()) && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  expect(setup.renderer.root.findDescendantById("welcome-wordmark")).toBeDefined()
  expect(submitted).toBe(1)
})
