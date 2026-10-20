import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createNotificationCoordinator } from "@/shell/notifications/coordinator"

test("SUBI notification claims do not suppress or overwrite upstream notifications", async () => {
  const upstream = '["sound:shared-event"]'
  localStorage.setItem("opencode:notification-sound", upstream)
  localStorage.removeItem("subi:notification-sound")
  const root = createRoot((dispose) => ({ dispose, coordinator: createNotificationCoordinator() }))
  const played: string[] = []

  try {
    await root.coordinator.sound("shared-event", () => void played.push("first"))
    await root.coordinator.sound("shared-event", () => void played.push("duplicate"))
    expect(played).toEqual(["first"])
    expect(localStorage.getItem("opencode:notification-sound")).toBe(upstream)
    expect(JSON.parse(localStorage.getItem("subi:notification-sound") ?? "null")).toEqual(["sound:shared-event"])
  } finally {
    root.dispose()
    localStorage.removeItem("opencode:notification-sound")
    localStorage.removeItem("subi:notification-sound")
  }
})

test("initial locale loads SUBI's saved preference rather than upstream's preference", async () => {
  localStorage.setItem("opencode.global.dat:language", '{"locale":"de"}')
  localStorage.setItem("subi:opencode.global.dat:language", '{"locale":"en"}')

  try {
    const language = await import("@/runtime/i18n/language")
    expect(await language.loadInitialLocale()).toBe("en")
    expect(localStorage.getItem("opencode.global.dat:language")).toBe('{"locale":"de"}')
  } finally {
    localStorage.removeItem("opencode.global.dat:language")
    localStorage.removeItem("subi:opencode.global.dat:language")
  }
})
