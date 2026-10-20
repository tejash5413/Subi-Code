import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { windowsCliScript } from "./vscode-cli.mjs"

for (const version of ["", "6d62b1d5da/"]) {
  test(`locates the CLI from VS Code's ${version ? "versioned" : "legacy"} Windows launcher`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "subicode-vscode-cli-"))
    try {
      const cli = path.join(root, version, "resources/app/out/cli.js")
      await mkdir(path.dirname(cli), { recursive: true })
      await writeFile(cli, "// fixture CLI")
      await mkdir(path.join(root, "bin"))
      await writeFile(
        path.join(root, "bin/code.cmd"),
        `@echo off\n"%~dp0..\\Code.exe" "%~dp0..\\${version.replaceAll("/", "\\")}resources\\app\\out\\cli.js" %*\n`,
      )
      assert.equal(await windowsCliScript(path.join(root, "bin/code.cmd")), cli)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
