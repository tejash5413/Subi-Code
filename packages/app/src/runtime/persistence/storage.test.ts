import { describe, expect, test } from "bun:test"
import { ServerScope } from "@/runtime/server/scope"
import { Persist, removePersisted } from "./storage"

describe("persist targets", () => {
  test.each([
    [
      Persist.global("distribution-sentinel"),
      "opencode.global.dat:distribution-sentinel",
      "subi:opencode.global.dat:distribution-sentinel",
    ],
    [{ key: "distribution-direct" }, "distribution-direct", "subi:default:distribution-direct"],
  ] as const)("keeps upstream browser data when removing a SUBI value: %p", (target, upstream, current) => {
    localStorage.setItem(upstream, '{"sentinel":"upstream"}')
    localStorage.setItem(current, '{"sentinel":"subi"}')

    try {
      removePersisted(target)
      expect(localStorage.getItem(upstream)).toBe('{"sentinel":"upstream"}')
      expect(localStorage.getItem(current)).toBeNull()
    } finally {
      localStorage.removeItem(upstream)
      localStorage.removeItem(current)
    }
  })

  test("workspace storage names are safe file names and normalize Windows paths", () => {
    const raw = Persist.workspace("C:\\Users\\foo", "vcs")
    const normalized = Persist.workspace("C:/Users/foo", "vcs")

    expect(raw.storage).toMatch(/^opencode\.workspace\.[a-zA-Z0-9._-]+\.dat$/)
    expect(raw.storage).toBe(normalized.storage)
    expect(raw.workspaceStorageAliases).toHaveLength(1)
    expect(raw.workspaceStorageAliases![0]).toMatch(/^opencode\.workspace\.[a-zA-Z0-9._-]+\.dat$/)
    expect(raw.workspaceStorageAliases![0]).not.toBe(raw.storage)
    expect(normalized.workspaceStorageAliases).toEqual(raw.workspaceStorageAliases)
    expect(Persist.workspace("/home/luke/repo", "vcs").workspaceStorageAliases).toBeUndefined()
  })

  test("removes workspace storage aliases and draft storage when removing persisted targets", () => {
    const workspace = Persist.workspace("C:\\Users\\foo", "terminal")
    const draft = Persist.draft("draft-a", "prompt")

    const keys = [
      `subi:${workspace.storage}:${workspace.key}`,
      `subi:${workspace.workspaceStorageAliases![0]}:${workspace.key}`,
      `subi:${draft.storage}:${draft.key}`,
    ]

    keys.forEach((key) => localStorage.setItem(key, '{"value":1}'))

    removePersisted(workspace)
    removePersisted(draft)

    expect(keys.map((key) => localStorage.getItem(key))).toEqual([null, null, null])
  })

  test("draft target isolates storage per draft and namespaces keys", () => {
    const a = Persist.draft("draft-a", "prompt")
    const b = Persist.draft("draft-b", "prompt")

    expect(a.key).toBe("draft:prompt")
    expect(a.storage).not.toBe(b.storage)
    expect(a.storage).not.toBe(Persist.workspace("/home/luke/repo", "prompt").storage)
  })

  test("server workspace target preserves local storage and isolates remote storage", () => {
    const local = Persist.serverWorkspace(ServerScope.local, "/home/luke/repo", "prompt")
    const windows = Persist.serverWorkspace("https://windows.example" as ServerScope, "/home/luke/repo", "prompt")
    const debian = Persist.serverWorkspace("https://debian.example" as ServerScope, "/home/luke/repo", "prompt")

    expect(local).toEqual(Persist.workspace("/home/luke/repo", "prompt"))
    expect(windows.storage).not.toBe(local.storage)
    expect(debian.storage).not.toBe(local.storage)
    expect(debian.storage).not.toBe(windows.storage)
    expect(windows.workspaceStorageAliases).toBeUndefined()
    expect(debian.workspaceStorageAliases).toBeUndefined()
  })

  test("server global target preserves local key and isolates remote keys", () => {
    expect(Persist.serverGlobal(ServerScope.local, "notification")).toEqual(Persist.global("notification"))
    expect(Persist.serverGlobal("https://debian.example" as ServerScope, "notification")).toEqual({
      storage: "opencode.global.dat",
      key: "https://debian.example\0notification",
    })
  })

  test("server global target cannot collide when scope and key contain colons", () => {
    expect(Persist.serverGlobal("a:b" as ServerScope, "c")).not.toEqual(Persist.serverGlobal("a" as ServerScope, "b:c"))
  })
})
