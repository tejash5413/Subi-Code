import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = path.resolve(process.argv[2])
const { version } = JSON.parse(await readFile(new URL("../sdks/npm/package.json", import.meta.url), "utf8"))
assert.match(version, /^\d+\.\d+\.\d+$/)
const tag = `v${version}`
const supported = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]
const platforms = process.env.SUBICODE_DESKTOP_PLATFORMS ? process.env.SUBICODE_DESKTOP_PLATFORMS.split(",") : supported
assert.ok(platforms.length > 0 && platforms.every(item => supported.includes(item)))
assert.equal(new Set(platforms).size, platforms.length)
const repo = "tejash5413/Subi-Code"
const assets = []
const desktopOnly = process.argv.includes("--desktop-only")
const commits = new Set()
const names = new Set()
for (const platform of platforms) {
  const directory = path.join(root, `subicode-downloads-${platform}`)
  const record = JSON.parse(await readFile(path.join(directory, `downloads-${platform}.json`), "utf8"))
  for (const field of desktopOnly ? ["nativeExecution", "desktopExecution"] : ["nativeExecution", "desktopExecution", "extensionExecution"])
    assert.match(record[field] ?? "", /^passed:/, `${platform}: ${field} missing`)
  assert.match(record.sourceCommit, /^[a-f0-9]{40}$/)
  commits.add(record.sourceCommit)
  assert.ok(record.downloads.some(item => item.product === "desktop"))
  if (desktopOnly) {
    assert.equal(record.productSelection, "desktop")
    assert.ok(record.downloads.every(item => item.product === "desktop"), "Desktop-only publication cannot include a VSIX")
  } else assert.ok(record.downloads.some(item => item.product === "vscode"))
  for (const item of record.downloads) {
    assert.equal(`${item.platform}-${item.arch}`, platform)
    assert.equal(item.version, version)
    assert.ok(["desktop", "vscode"].includes(item.product))
    assert.ok(/^(subi-desktop-[a-z0-9_-]+\.(exe|dmg|zip|AppImage|deb|rpm)|subicode-[a-z0-9-]+\.vsix)$/.test(item.filename))
    assert.ok(!names.has(item.filename), "Duplicate release filename")
    names.add(item.filename)
    const file = path.join(directory, item.filename)
    const bytes = await readFile(file)
    assert.equal(bytes.length, item.size, `${item.filename}: size changed`)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, `${item.filename}: checksum changed`)
    const url = `https://github.com/${repo}/releases/download/${tag}/${item.filename}`
    assert.equal(item.url, url)
    assets.push({ file, download: { ...item, signed: false } })
  }
}
assert.equal(commits.size, 1, "Desktop packages must use the same source commit")
const manifest = { version, cli: {
  available: true, nodeMinimum: 22,
  command: `npm install -g @subicodeagent/subi-cli@${version}`, platforms: supported,
}, desktopSourceCommit: [...commits][0], downloads: assets.map(item => item.download) }
const manifestFile = path.join(root, "subicode-release.json")
const checksumFile = path.join(root, "SHA256SUMS.txt")
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n")
await writeFile(checksumFile, assets.map(({ download }) => `${download.sha256}  ${download.filename}`).join("\n") + "\n")
console.log(`Verified ${assets.length} ${desktopOnly ? "desktop" : "desktop and VSIX"} downloads across ${platforms.length} native platforms`)
if (!process.argv.includes("--publish")) {
  console.log(`Preflight only: ${manifestFile}`)
  process.exit(0)
}

function gh(args) {
  const result = spawnSync("gh", args[0] === "api" ? args : [...args, "--repo", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr || "GitHub release command failed")
  return result.stdout
}
const source = [...commits][0]
// The by-tag REST endpoint hides draft releases. The authenticated list includes
// their asset records, so a failed upload can resume before publication.
const releases = JSON.parse(gh(["api", `repos/${repo}/releases?per_page=100`]))
const existing = releases.find(item => item.tag_name === tag)
const remote = existing
if (existing) {
  if (remote.assets.some(item => item.name === "subicode-release.json")) {
    const previous = path.join(root, "previous")
    await mkdir(previous, { recursive: true })
    gh(["release", "download", tag, "--pattern", "subicode-release.json", "--dir", previous, "--clobber"])
    const previousManifest = JSON.parse(await readFile(path.join(previous, "subicode-release.json"), "utf8"))
    assert.equal(previousManifest.version, version, "Existing release version mismatch")
    assert.equal(previousManifest.desktopSourceCommit, source, "Existing desktop release uses another source commit")
    for (const item of previousManifest.downloads) {
      const candidate = manifest.downloads.find(value => value.filename === item.filename)
      if (candidate) assert.equal(candidate.sha256, item.sha256, "Published installers cannot be overwritten")
      if (!candidate) manifest.downloads.push(item)
    }
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n")
    await writeFile(checksumFile, manifest.downloads.map(item => `${item.sha256}  ${item.filename}`).join("\n") + "\n")
  }
}
const notes = path.join(root, "release-notes.md")
await writeFile(notes, `SubiCode ${version} provides the terminal CLI, desktop app and VS Code extension.\n\n` +
  `CLI: \`npm install -g @subicodeagent/subi-cli@${version}\` (Node.js 22+). npm selects Windows, macOS or glibc Linux on x64 or ARM64.\n\n` +
  `Desktop: choose the installer for your system and processor. Windows uses .exe, macOS .dmg or .zip, Linux AppImage, .deb or .rpm. Install extensions using VS Code's Install from VSIX command.\n\n` +
  `Verified desktop targets: ${[...new Set(manifest.downloads.filter(item => item.product === "desktop").map(item => `${item.platform}-${item.arch}`))].join(", ")}. Desktop checks cover startup, Plan/Build, settings, MCP form and plugin/skill setup. Verified VS Code extension targets: ${[...new Set(manifest.downloads.filter(item => item.product === "vscode").map(item => `${item.platform}-${item.arch}`))].join(", ")}. Extension checks cover bundled CLI startup and terminal reuse. Other product/processor combinations remain unavailable until their own native checks pass. Desktop source: ${source}.\n\n` +
  `These desktop installers are unsigned; macOS builds are not notarized. Operating-system publisher checks may require manual approval. SHA256SUMS.txt lists every download's checksum.\n\n` +
  `Account/provider access, billing and mobile pairing require their own live-service checks and are not qualified by these packaging tests.\n\n` +
  `Guides: https://stlearnsmart.in/subi-code/docs\n`)
if (!existing) gh(["release", "create", tag, "--target", source, "--draft", "--title", `SubiCode ${version}`, "--notes-file", notes])
for (const item of assets) {
  const previous = remote?.assets.find(asset => asset.name === item.download.filename)
  if (previous) {
    assert.equal(previous.digest, `sha256:${item.download.sha256}`, "Existing release asset checksum mismatch")
    continue
  }
  gh(["release", "upload", tag, item.file])
}
gh(["release", "upload", tag, manifestFile, checksumFile, "--clobber"])
const uploaded = JSON.parse(gh(["release", "view", tag, "--json", "assets"]))
for (const { download } of assets) {
  const asset = uploaded.assets.find(item => item.name === download.filename)
  assert.ok(asset && asset.size === download.size && asset.state === "uploaded", `${download.filename}: upload incomplete`)
}
gh(["release", "edit", tag, "--draft=false", "--latest", "--notes-file", notes])
console.log(`Published https://github.com/${repo}/releases/tag/${tag}`)
