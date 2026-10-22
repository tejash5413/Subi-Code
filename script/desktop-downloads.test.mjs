import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const scripts = path.dirname(fileURLToPath(import.meta.url))

test("desktop publication checks each product without releasing an unverified extension", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "subi-download-contract-"))
  try {
    for (const [name, desktopOnly, desktop, extension, failure, accepted] of [
      ["complete", false, "passed: startup", "passed: terminal reuse", undefined, true],
      ["pending-extension", false, "passed: startup", undefined, "VS Code extension host qualification did not complete", false],
      ["desktop-only", true, "passed: startup", undefined, "VS Code extension host qualification did not complete", true],
      ["failed-desktop", true, "failed", undefined, "VS Code extension host qualification did not complete", false],
      ["unrelated-failure", true, "passed: startup", undefined, "Installer checksum mismatch", false],
    ]) {
      const source = path.join(root, name, "candidate")
      const output = path.join(root, name, "downloads")
      const destination = path.join(output, "subicode-downloads-darwin-x64")
      await mkdir(path.join(source, "desktop"), { recursive: true })
      await mkdir(path.join(source, "packages"))
      await writeFile(path.join(source, "desktop/subi-desktop-mac-x64.dmg"), "installer fixture")
      await writeFile(path.join(source, "subicode-darwin-x64.vsix"), "extension fixture")
      await writeFile(path.join(source, "packages/qualification.json"), JSON.stringify({
        version: "2.0.0", channel: "prod", platform: "darwin-x64",
        nativeExecution: "passed: native version", desktopExecution: desktop,
        extensionExecution: extension, failure, npm: { sourceCommit: "a".repeat(40) },
      }))
      const flags = desktopOnly ? ["--desktop-only"] : []
      const prepared = spawnSync(process.execPath, [path.join(scripts, "prepare-desktop-downloads.mjs"), source, destination, ...flags], { encoding: "utf8", windowsHide: true })
      assert.equal(prepared.status === 0, accepted, `${name}: ${prepared.stderr}`)
      if (!accepted) continue
      const record = JSON.parse(await readFile(path.join(destination, "downloads-darwin-x64.json"), "utf8"))
      assert.deepEqual(record.downloads.map(item => item.product), desktopOnly ? ["desktop"] : ["desktop", "vscode"])
      const verify = extra => spawnSync(process.execPath, [path.join(scripts, "publish-subicode-desktop.mjs"), output, ...extra], {
        encoding: "utf8", windowsHide: true, env: { ...process.env, SUBICODE_DESKTOP_PLATFORMS: "darwin-x64" },
      })
      const verified = verify(flags)
      assert.equal(verified.status, 0, `${name}: ${verified.stderr}`)
      if (desktopOnly) {
        assert.notEqual(verify([]).status, 0, "Full publication still requires extension qualification")
        record.downloads.push({ ...record.downloads[0], product: "vscode", filename: "subicode-darwin-x64.vsix" })
        await writeFile(path.join(destination, "downloads-darwin-x64.json"), JSON.stringify(record))
        assert.notEqual(verify(flags).status, 0, "Desktop-only publication rejects VSIX files")
        record.downloads.pop()
        await writeFile(path.join(destination, "downloads-darwin-x64.json"), JSON.stringify(record))
      }
      await writeFile(path.join(destination, record.downloads[0].filename), "changed bytes")
      assert.notEqual(verify(flags).status, 0, "Installer bytes must still match qualification checksums")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
