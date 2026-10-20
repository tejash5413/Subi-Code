const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { test } = require("node:test")

async function fixture(run, nativeVersion) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subicode-npm-launcher-"))
  try {
    await fs.mkdir(path.join(directory, "bin"))
    await fs.copyFile(path.join(__dirname, "../bin/subi.cjs"), path.join(directory, "bin/subi.cjs"))
    await fs.copyFile(path.join(__dirname, "../package.json"), path.join(directory, "package.json"))
    if (nativeVersion) {
      const native = path.join(directory, "node_modules/@subicodeagent", `subi-cli-${process.platform}-${process.arch}`)
      await fs.mkdir(path.join(native, "bin"), { recursive: true })
      await fs.writeFile(path.join(native, "package.json"), JSON.stringify({ version: nativeVersion }))
      // A real Node executable exercises argument forwarding and exit codes without a provider or shell.
      await fs.copyFile(process.execPath, path.join(native, "bin", process.platform === "win32" ? "subi.exe" : "subi"))
      if (process.platform !== "win32") await fs.chmod(path.join(native, "bin/subi"), 0o755)
    }
    await run(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function launch(directory, args) {
  return spawnSync(process.execPath, [path.join(directory, "bin/subi.cjs"), ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(SUBI_BIN_PATH|NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/.test(key),
      ),
    ),
  })
}

test("explains how to repair missing optional native dependencies", () =>
  fixture(async (directory) => {
    const result = launch(directory, ["--version"])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /npm install -g @subicodeagent\/subi-cli --include=optional/)
  }))

test("rejects a stale native package before executing it", () =>
  fixture(async (directory) => {
    const result = launch(directory, ["--version"])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /version mismatch/)
  }, "1.0.0"))

test("forwards arguments without a shell and preserves the native exit code", () =>
  fixture(async (directory) => {
    const expected = ["a file with spaces", "$(literal)", "hello&world"]
    const result = launch(directory, [
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)));process.exit(17)",
      ...expected,
    ])
    assert.equal(result.error, undefined)
    assert.equal(result.status, 17)
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected)
  }, require("../package.json").version))
