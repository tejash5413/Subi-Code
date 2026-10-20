import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import manifest from "../package.json"

test("installs the subi command without claiming OpenCode commands", () => {
  expect(manifest.bin).toEqual({ subi: "./bin/subi.cjs" })
})

test.each([true, false])("launcher accepts only the SUBI binary override: configured=%s", async (configured) => {
  const node = Bun.which("node")
  if (!node) throw new Error("Node.js is required to test the distributed launcher")
  const root = await mkdtemp(path.join(tmpdir(), "subi-launcher-"))

  try {
    await mkdir(path.join(root, "bin"))
    await copyFile(path.join(import.meta.dir, "../bin/opencode.cjs"), path.join(root, "bin/opencode.cjs"))
    await writeFile(path.join(root, "bin/subi.cjs"), 'require("./opencode.cjs")\n')
    const child = Bun.spawn([node, path.join(root, "bin/subi.cjs"), "-e", "process.stdout.write('fixture binary')"], {
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_BIN_PATH: process.execPath,
        SUBI_BIN_PATH: configured ? process.execPath : undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code).toBe(configured ? 0 : 1)
    expect(stdout).toBe(configured ? "fixture binary" : "")
    if (!configured) expect(stderr).toContain("subi CLI package")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
