import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../../script/publish-subicode-desktop.mjs", import.meta.url))
const platforms = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]
async function fixture(mutation) {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-download-contract-"))
  for (const target of platforms) {
    const [platform, arch] = target.split("-")
    const directory = path.join(root, `subicode-downloads-${target}`)
    await mkdir(directory)
    const downloads = []
    for (const product of ["desktop", "vscode"]) {
      const filename = product === "desktop" ? `subi-desktop-${platform}-${arch}.zip` : `subicode-${target}.vsix`
      const bytes = Buffer.from(`${product} artifact for ${target}`)
      await writeFile(path.join(directory, filename), bytes)
      downloads.push({ product, platform, arch, version: "2.0.0", filename, size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url: `https://github.com/tejash5413/Subi-Code/releases/download/v2.0.0/${filename}` })
    }
    const record = { sourceCommit: "1".repeat(40), nativeExecution: "passed: native CLI", desktopExecution: "passed: desktop", extensionExecution: "passed: extension", downloads }
    if (target === "linux-arm64") mutation?.(record)
    await writeFile(path.join(directory, `downloads-${target}.json`), JSON.stringify(record))
  }
  return root
}

test("release preflight creates the public manifest only from six qualified, unchanged native artifact sets", async () => {
  const root = await fixture()
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(await readFile(path.join(root, "subicode-release.json"), "utf8"))
  assert.equal(manifest.downloads.length, 12)
  assert.equal(manifest.cli.available, true)
  assert.ok(manifest.downloads.every(item => item.signed === false))
})

for (const [name, mutation] of [
  ["pending qualification", record => { record.desktopExecution = "pending" }],
  ["changed installer", record => { record.downloads[0].sha256 = "0".repeat(64) }],
  ["mixed source revisions", record => { record.sourceCommit = "2".repeat(40) }],
  ["wrong version", record => { record.downloads[0].version = "2.0.1" }],
]) test(`release preflight rejects ${name}`, async () => {
  const root = await fixture(mutation)
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  assert.notEqual(result.status, 0)
})
