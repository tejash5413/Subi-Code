import { afterEach, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { writeJsonAtomic } from "../../src/util/persistence"
import { tmpdir } from "../fixture/fixture"

// Spy on the ESM export consumed by persistence, not Node's separate default object.
const fs = await import("fs/promises")

afterEach(() => spyOn(fs, "rename").mockRestore())

test.each(process.platform === "win32" ? ["EPERM", "EBUSY"] : [])(
  "atomic JSON replacement survives a transient Windows %s sharing violation",
  async (code) => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "tabs.json")
    await fs.writeFile(file, '{"title":"before"}')
    const rename = fs.rename.bind(fs)
    let attempts = 0
    spyOn(fs, "rename").mockImplementation(async (source, target) => {
      attempts++
      if (attempts === 1) throw Object.assign(new Error("Windows sharing violation"), { code })
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ title: "before" })
      return rename(source, target)
    })
    await writeJsonAtomic(file, { title: "after" })
    expect(attempts).toBe(2)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ title: "after" })
    expect(await fs.readdir(directory.path)).toEqual(["tabs.json"])
  },
)

test.each(["ENOSPC", "EPERM"])(
  "permanent %s failure preserves the old file and removes the temporary file",
  async (code) => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "tabs.json")
    await fs.writeFile(file, '{"title":"before"}')
    const rename = spyOn(fs, "rename").mockRejectedValue(
      Object.assign(new Error("permanent filesystem failure"), { code }),
    )
    await expect(writeJsonAtomic(file, { title: "after" })).rejects.toHaveProperty("code", code)
    expect(rename).toHaveBeenCalledTimes(process.platform === "win32" && code === "EPERM" ? 6 : 1)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ title: "before" })
    expect(await fs.readdir(directory.path)).toEqual(["tabs.json"])
  },
)
