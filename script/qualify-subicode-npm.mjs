import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const output = path.resolve(process.argv[2])
const fixture = await mkdtemp(path.join(tmpdir(), "subicode-npm-install-"))
const qualificationFile = path.join(output, "packages/qualification.json")
const qualification = JSON.parse(await readFile(qualificationFile, "utf8"))
const manifests = await Promise.all(
  ["cli", "npm-wrapper"].map(async (name) =>
    JSON.parse(await readFile(path.join(output, "packages", name, "package.json"), "utf8")),
  ),
)
const packages = await Promise.all(
  manifests.map(async (manifest) => {
    const filename = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`
    const bytes = await readFile(path.join(output, filename))
    return { manifest, filename, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }
  }),
)
assert.equal(manifests[0].name, `@subicodeagent/subi-cli-${process.platform}-${process.arch}`)
assert.equal(manifests[1].name, "@subicodeagent/subi-cli")
assert.equal(manifests[0].version, qualification.version)
assert.equal(manifests[1].version, qualification.version)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)/i.test(key) &&
      !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|SUBI_BIN_PATH|npm_config_)/i.test(key),
  ),
)
Object.assign(env, { NO_PROXY: "localhost,127.0.0.1", npm_config_update_notifier: "false" })
const config = path.join(fixture, "npmrc")
await writeFile(config, "")
let origin
const server = createServer((request, response) => {
  const key = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1)
  const tarball = packages.find((item) => item.filename === key)
  if (tarball) return createReadStream(path.join(output, tarball.filename)).pipe(response)
  const item = packages.find((item) => item.manifest.name === key)
  if (!item) {
    response.writeHead(404)
    return response.end("{}")
  }
  response.setHeader("Content-Type", "application/json")
  response.end(
    JSON.stringify({
      name: item.manifest.name,
      "dist-tags": { latest: item.manifest.version },
      versions: {
        [item.manifest.version]: {
          ...item.manifest,
          dist: {
            tarball: `${origin}/${item.filename}`,
            integrity: item.integrity,
          },
        },
      },
    }),
  )
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
origin = `http://127.0.0.1:${server.address().port}`
async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => {
      stdout += data
    })
    child.stderr.on("data", (data) => {
      stderr += data
    })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr}`)),
    )
  })
}
// Use npm's actual CLI entrypoint so Windows does not need a shell to launch npm.cmd.
const candidates = [
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
]
let npm
for (const candidate of candidates) {
  if (
    await access(candidate).then(
      () => true,
      () => false,
    )
  ) {
    npm = candidate
    break
  }
}
if (!npm) {
  server.close()
  throw new Error("The Node.js installation must include npm")
}
const prefix = path.join(fixture, "prefix")
try {
  await run(process.execPath, [
    npm,
    "install",
    "--global",
    "--prefix",
    prefix,
    "--cache",
    path.join(fixture, "cache"),
    "--userconfig",
    config,
    "--registry",
    origin,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `@subicodeagent/subi-cli@${qualification.version}`,
  ])
  const modules = await run(process.execPath, [npm, "root", "--global", "--prefix", prefix])
  const launcher = path.join(modules, "@subicodeagent/subi-cli/bin/subi.cjs")
  await access(path.join(prefix, ...(process.platform === "win32" ? ["subi.cmd"] : ["bin/subi"])))
  assert.equal(await run(process.execPath, [launcher, "--version"]), `subi v${qualification.version}`)
  assert.match(await run(process.execPath, [launcher, "mcp", "add", "--help"]), /mcp/i)
  qualification.npmExecution = "passed: clean global registry install, native selection, version and MCP command"
  qualification.npm = {
    sourceCommit: process.env.GITHUB_SHA,
    native: { name: packages[0].manifest.name, filename: packages[0].filename, integrity: packages[0].integrity },
    wrapper: { name: packages[1].manifest.name, filename: packages[1].filename, integrity: packages[1].integrity },
  }
  console.log(`SubiCode npm global install passed for ${process.platform}/${process.arch}.`)
} catch (error) {
  qualification.npmExecution = "failed"
  throw error
} finally {
  await new Promise((resolve) => server.close(resolve))
  await writeFile(qualificationFile, JSON.stringify(qualification, null, 2) + "\n")
}
