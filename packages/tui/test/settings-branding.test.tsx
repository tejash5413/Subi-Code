import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"

test.each([
  [100, "opencode", "Subi Code"],
  [44, "opencode", "Subi Code"],
  [100, "opencode2", "Subi Code 2"],
  [44, "opencode2", "Subi Code 2"],
] as const)("settings at %s columns brand the saved %s theme as %s", async (width, name, label) => {
  await using setup = await createAppFixture({
    width,
    height: 35,
    config: {
      animations: false,
      theme: { name },
      experimental: { "new-designs": name === "opencode2" },
      keybinds: { "opencode.settings": "f6", "theme.switch": "f7" },
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F6")
  const settings = await setup.waitForFrame((frame) => frame.includes("Color mode"))
  expect(settings.split("\n").find((line) => /\bTheme\s/.test(line))).toContain(label)
  expect(setup.config().theme?.name).toBe(name)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Color mode"))
  setup.mockInput.pressKey("F7")
  await setup.waitForFrame(
    (frame) =>
      (frame.includes("Themes") || frame.includes("Search themes")) &&
      setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Subi Code")
  await setup.waitForFrame((frame) => frame.includes("Subi Code") && !frame.includes("No items available"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Search themes") && !frame.includes("Themes"))
  expect(setup.config().theme?.name).toBe("opencode")
})
