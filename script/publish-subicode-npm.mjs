import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { gunzipSync } from "node:zlib"

const root = path.resolve(process.argv[2])
const publish = process.argv.includes("--publish")
const platforms = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]
const expected = JSON.parse(await readFile(new URL("../sdks/npm/package.json", import.meta.url), "utf8"))
const records = []
let wrapper
let launcher
for (const platform of platforms) {
  const directory = path.join(root, platform)
  const q = JSON.parse(await readFile(path.join(directory, "packages/qualification.json"), "utf8"))
  assert.equal(q.version, expected.version, `${platform}: version mismatch`)
  assert.equal(q.channel, "prod", `${platform}: production channel required`)
  assert.equal(q.platform, platform, `${platform}: platform mismatch`)
  assert.match(q.nativeExecution ?? "", /^passed:/, `${platform}: native CLI check missing`)
  assert.match(q.npmExecution ?? "", /^passed:/, `${platform}: npm installation check missing`)
  if (process.env.GITHUB_SHA)
    assert.equal(q.npm.sourceCommit, process.env.GITHUB_SHA, `${platform}: source commit mismatch`)
  for (const kind of ["native", "wrapper"]) {
    const item = q.npm[kind]
    const name = kind === "native" ? `@subicodeagent/subi-cli-${platform}` : "@subicodeagent/subi-cli"
    assert.equal(item.name, name)
    assert.equal(item.filename, `${name.replace(/^@/, "").replace("/", "-")}-${expected.version}.tgz`)
    const file = path.join(directory, item.filename)
    const bytes = await readFile(file)
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    assert.equal(item.integrity, integrity, `${platform}: ${kind} package changed after qualification`)
    const record = { ...item, file }
    if (kind === "native") records.push(record)
    if (kind === "wrapper") {
      const contents = launcherContents(bytes)
      if (launcher) assert.equal(launcher, contents, "Platform jobs used different public launcher contents")
      launcher = contents
      wrapper = record
    }
  }
}

function launcherContents(bytes) {
  // Windows npm packs bin files as 0644; Unix packs them as 0755. Compare file bytes,
  // while the qualification checksum above still authenticates each complete archive.
  const tar = gunzipSync(bytes)
  const entries = new Map()
  for (let offset = 0; offset < tar.length && tar[offset] !== 0; ) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/s, "")
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8)
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, "Invalid launcher archive")
    assert.ok(tar[offset + 156] === 0 || tar[offset + 156] === 48, "Launcher archive must contain regular files")
    assert.ok(!entries.has(name), "Duplicate launcher archive entry")
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  assert.deepEqual([...entries.keys()].sort(), [
    "package/LICENSE",
    "package/README.md",
    "package/bin/subi.cjs",
    "package/package.json",
  ])
  const manifest = JSON.parse(entries.get("package/package.json").toString())
  assert.equal(manifest.name, expected.name)
  assert.equal(manifest.version, expected.version)
  return JSON.stringify(
    [...entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, body]) => [name, createHash("sha512").update(body).digest("hex")]),
  )
}
console.log(`Verified six native npm packages and the identical public launcher for ${expected.version}.`)
if (!publish) {
  console.log("Preflight only. Add --publish to publish the native packages first, then @subicodeagent/subi-cli.")
} else {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ]
  let npm
  for (const candidate of candidates) {
    if (
      await readFile(candidate).then(
        () => true,
        () => false,
      )
    ) {
      npm = candidate
      break
    }
  }
  assert.ok(npm, "The Node.js installation must include npm")
  async function run(args, interactive = false) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npm, ...args], {
        windowsHide: true,
        stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (data) => {
        stdout += data
      })
      child.stderr?.on("data", (data) => {
        stderr += data
      })
      child.once("error", reject)
      child.once("exit", (code) => resolve({ code, stdout, stderr }))
    })
  }
  for (const item of [...records, wrapper]) {
    const existing = await run([
      "view",
      `${item.name}@${expected.version}`,
      "dist.integrity",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ])
    if (existing.code === 0) {
      assert.equal(
        JSON.parse(existing.stdout),
        item.integrity,
        `${item.name}: an immutable version with different contents already exists`,
      )
      console.log(`Already published: ${item.name}@${expected.version}`)
      continue
    }
    if (!/E404|404 Not Found/.test(existing.stderr)) throw new Error(`Registry check failed: ${existing.stderr}`)
    const result = await run(
      [
        "publish",
        item.file,
        "--access=public",
        "--tag=latest",
        "--registry=https://registry.npmjs.org/",
        ...(process.argv.includes("--provenance") ? ["--provenance"] : []),
      ],
      Boolean(process.stdin.isTTY),
    )
    if (result.code !== 0) throw new Error(`Publish failed for ${item.name}: ${result.stderr}`)
    console.log(`Published: ${item.name}@${expected.version}`)
  }
}
