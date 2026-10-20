import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

const output = path.resolve(process.argv[2])
const destination = path.resolve(process.argv[3])
const qualification = JSON.parse(await readFile(path.join(output, "packages/qualification.json"), "utf8"))
assert.equal(qualification.version, "2.0.0")
assert.equal(qualification.channel, "prod")
assert.ok(!qualification.failure, "Qualification failed")
for (const field of ["nativeExecution", "desktopExecution", "extensionExecution"])
  assert.match(qualification[field] ?? "", /^passed:/, `${field} must pass before download publication`)
const [platform, arch] = qualification.platform.split("-")
assert.ok(["win32", "darwin", "linux"].includes(platform) && ["x64", "arm64"].includes(arch))
await mkdir(destination, { recursive: true })
const files = (await readdir(path.join(output, "desktop"))).filter(name =>
  /^subi-desktop-[a-z0-9_-]+\.(exe|dmg|zip|AppImage|deb|rpm)$/.test(name),
)
assert.ok(files.length > 0, "No installers found")
const assets = files.map(name => ({ name, source: path.join(output, "desktop", name), product: "desktop" }))
assets.push({ name: `subicode-${qualification.platform}.vsix`, source: path.join(output, `subicode-${qualification.platform}.vsix`), product: "vscode" })
const downloads = await Promise.all(assets.map(async item => {
  const bytes = await readFile(item.source)
  await copyFile(item.source, path.join(destination, item.name))
  return {
    product: item.product, platform, arch, version: "2.0.0", filename: item.name,
    format: path.extname(item.name).slice(1), size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/tejash5413/Subi-Code/releases/download/v2.0.0/${item.name}`,
    signed: false,
  }
}))
await writeFile(path.join(destination, `downloads-${qualification.platform}.json`), JSON.stringify({
  sourceCommit: qualification.npm.sourceCommit,
  nativeExecution: qualification.nativeExecution,
  desktopExecution: qualification.desktopExecution,
  extensionExecution: qualification.extensionExecution,
  downloads,
}, null, 2) + "\n")
console.log(`Prepared ${downloads.length} qualified downloads for ${qualification.platform}`)
