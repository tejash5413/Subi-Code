import { mkdir } from "node:fs/promises"
import path from "node:path"
import { distributionTarget, stageDistribution, stageNpmWrapper } from "./distribution-packages"

const root = path.resolve(import.meta.dirname, "../../..")

const version = process.env.OPENCODE_VERSION

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("Set OPENCODE_VERSION to an explicit semantic version before building distributions")

const target = distributionTarget(process.platform, process.arch)

const output = path.resolve(root, process.argv[2] ?? `artifacts/platforms/${version}/${target.vscode}`)

await mkdir(path.dirname(output), { recursive: true })

// Reusing a CLI is explicit, and its version must still match the requested release.
const cliDist = process.env.OPENCODE_CLI_DIST ?? path.join(output, "cli-build")

const env = {
  ...process.env,
  OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL ?? "dev",
  OPENCODE_CLI_TARGET: target.target,
  OPENCODE_CLI_DIST: cliDist,
}

async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" })

  if ((await child.exited) !== 0) throw new Error(`Distribution command failed: ${command.join(" ")}`)
}

if (!process.env.OPENCODE_CLI_DIST)
  await run([
    process.execPath,
    "run",
    "packages/cli/script/build.ts",
    `--target=${target.directory.replace("cli-", "opencode-")}`,
    "--skip-install",
    `--outdir=${cliDist}`,
  ])

const manifest = await Bun.file(path.join(cliDist, target.directory, "package.json")).json()

if (manifest.version !== version) throw new Error(`CLI version ${manifest.version} does not match ${version}`)

await run([process.execPath, "run", "package"], path.join(root, "sdks/vscode"))

await mkdir(output, { recursive: true })

const staged = await stageDistribution(root, cliDist, path.join(output, "packages"), process.platform, process.arch)

await run(["npm", "pack", "--ignore-scripts", "--pack-destination", output], staged.cli)

await run(
  [
    process.execPath,
    "x",
    "@vscode/vsce@3.6.0",
    "package",
    "--no-dependencies",
    "--skip-license",
    "--target",
    target.vscode,
    "--out",
    path.join(output, `subicode-${target.vscode}.vsix`),
  ],
  staged.extension,
)

await run(["node", path.join(staged.cli, "bin/subi.cjs"), "--version"])

await run(["node", path.join(staged.cli, "bin/subi.cjs"), "mcp", "add", "--help"])

const qualification = path.join(output, "packages/qualification.json")

await Bun.write(
  qualification,
  JSON.stringify(
    {
      ...(await Bun.file(qualification).json()),
      channel: env.OPENCODE_CHANNEL,
      nativeExecution: "passed: version and MCP command",
    },
    null,
    2,
  ) + "\n",
)

const wrapper = await stageNpmWrapper(root, path.join(output, "packages/npm-wrapper"), version)
await run(["npm", "pack", "--ignore-scripts", "--pack-destination", output], wrapper)
await run(["node", path.join(root, "script/qualify-subicode-npm.mjs"), output])

await run([process.execPath, "run", "prebuild"], path.join(root, "packages/desktop"))

await run([process.execPath, "run", "build"], path.join(root, "packages/desktop"))

await run(
  [
    process.execPath,
    "run",
    "package",
    `--${process.arch}`,
    "--publish",
    "never",
    ...(process.platform === "darwin" ? ["--config.mac.notarize=false"] : []),
    `--config.extraMetadata.version=${version}`,
    `--config.directories.output=${path.join(output, "desktop")}`,
  ],
  path.join(root, "packages/desktop"),
)

console.log(
  `SubiCode packages created at ${output}. Native desktop and extension-host execution still require qualification.`,
)
