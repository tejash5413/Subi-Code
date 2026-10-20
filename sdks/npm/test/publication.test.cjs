const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { test } = require("node:test")
const { gzipSync } = require("node:zlib")

function launcherArchive(mode, readme = "launcher fixture") {
  const chunks = []
  for (const [name, content] of [
    ["package/LICENSE", "license fixture"],
    ["package/bin/subi.cjs", "#!/usr/bin/env node\n"],
    ["package/package.json", JSON.stringify({ name: "@subicodeagent/subi-cli", version: "2.0.0" })],
    ["package/README.md", readme],
  ]) {
    const bytes = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name)
    header.write(`${(name.endsWith(".cjs") ? mode : 0o644).toString(8).padStart(7, "0")}\0`, 100)
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124)
    header.fill(32, 148, 156)
    header[156] = 48
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

test("publication preflight rejects missing qualification and modified packages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subicode-npm-publication-"))
  const platforms = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]
  try {
    for (const platform of platforms) {
      const directory = path.join(root, platform)
      await fs.mkdir(path.join(directory, "packages"), { recursive: true })
      const entries = []
      for (const name of [`@subicodeagent/subi-cli-${platform}`, "@subicodeagent/subi-cli"]) {
        const bytes =
          name === "@subicodeagent/subi-cli"
            ? launcherArchive(platform.startsWith("win32") ? 0o644 : 0o755)
            : Buffer.from(`fixture ${name}`)
        const item = {
          name,
          filename: `${name.replace(/^@/, "").replace("/", "-")}-2.0.0.tgz`,
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        }
        await fs.writeFile(path.join(directory, item.filename), bytes)
        entries.push(item)
      }
      await fs.writeFile(
        path.join(directory, "packages/qualification.json"),
        JSON.stringify({
          version: "2.0.0",
          channel: "prod",
          platform,
          nativeExecution: "passed: fixture",
          npmExecution: "passed: fixture",
          npm: { sourceCommit: process.env.GITHUB_SHA, native: entries[0], wrapper: entries[1] },
        }),
      )
    }
    const run = () =>
      spawnSync(process.execPath, [path.join(__dirname, "../../../script/publish-subicode-npm.mjs"), root], {
        encoding: "utf8",
      })
    const valid = run()
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /Preflight only/)
    const file = path.join(root, "win32-x64/packages/qualification.json")
    const q = JSON.parse(await fs.readFile(file, "utf8"))
    const wrapperFile = path.join(root, "win32-x64", q.npm.wrapper.filename)
    const original = await fs.readFile(wrapperFile)
    const different = launcherArchive(0o644, "different launcher contents")
    await fs.writeFile(wrapperFile, different)
    await fs.writeFile(
      file,
      JSON.stringify({
        ...q,
        npm: {
          ...q.npm,
          wrapper: { ...q.npm.wrapper, integrity: `sha512-${createHash("sha512").update(different).digest("base64")}` },
        },
      }),
    )
    const mismatch = run()
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /different public launcher contents/)
    await fs.writeFile(wrapperFile, original)
    await fs.writeFile(file, JSON.stringify({ ...q, channel: "dev" }))
    const development = run()
    assert.notEqual(development.status, 0)
    assert.match(development.stderr, /production channel required/)
    await fs.writeFile(file, JSON.stringify({ ...q, npmExecution: "pending" }))
    const pending = run()
    assert.notEqual(pending.status, 0)
    assert.match(pending.stderr, /npm installation check missing/)
    await fs.writeFile(file, JSON.stringify(q))
    await fs.appendFile(path.join(root, "win32-x64", q.npm.native.filename), "modified")
    const modified = run()
    assert.notEqual(modified.status, 0)
    assert.match(modified.stderr, /package changed after qualification/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
