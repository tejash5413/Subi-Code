import { chmod, copyFile, cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { NativeArch } from "../../../script/native-arch"
import { CLI_BINARIES } from "./utils"

export function distributionTarget(platform: string, arch: string) {
  const target = CLI_BINARIES.find((item) => item.os === platform && item.cpu === arch)

  if (!target) throw new Error(`Unsupported SubiCode distribution: ${platform}/${arch}`)

  return {
    ...target,
    directory: target.package.replace("@opencode/", ""),
    binary: platform === "win32" ? "subi.exe" : "subi",
    vscode: `${platform}-${arch}`,
  }
}

/** Stage self-contained packages; never modify the source extension or an installed user profile. */
export async function stageDistribution(root: string, cliDist: string, output: string, platform: string, arch: string) {
  const target = distributionTarget(platform, arch)
  const source = path.join(cliDist, target.directory)
  const manifest = await Bun.file(path.join(source, "package.json")).json()

  if (!manifest.version || manifest.os?.[0] !== platform || manifest.cpu?.[0] !== arch)
    throw new Error(`CLI manifest does not match ${target.vscode}: ${source}`)
  const executable = path.join(source, "bin", target.binary)
  const bytes = Buffer.from(await Bun.file(executable).arrayBuffer())

  const format = new Map([
    ["win32", "PE"],
    ["darwin", "Mach-O"],
    ["linux", "ELF"],
  ]).get(platform)

  if (NativeArch.images(bytes)[0]?.format !== format) throw new Error(`CLI format does not match ${platform}`)

  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported architecture: ${arch}`)
  await NativeArch.verify(executable, arch)
  // Exclusive creation preserves an earlier package, including failed-build evidence.
  await mkdir(output)
  const cli = path.join(output, "cli")
  const extension = path.join(output, "extension")
  await mkdir(path.join(cli, "bin"), { recursive: true })
  await copyFile(executable, path.join(cli, "bin", target.binary))
  await chmod(path.join(cli, "bin", target.binary), 0o755)
  const launcher = await Bun.file(path.join(root, "packages/cli/bin/opencode.cjs")).text()
  const boundary = launcher.indexOf("const envPath = process.env.SUBI_BIN_PATH")

  if (boundary < 0) throw new Error("CLI launcher entry point is missing")
  await Bun.write(
    path.join(cli, "bin/subi.cjs"),
    launcher.slice(0, boundary) +
      `run(process.env.SUBI_BIN_PATH || path.join(__dirname, ${JSON.stringify(target.binary)}))\n`,
  )
  await chmod(path.join(cli, "bin/subi.cjs"), 0o755)
  await copyFile(path.join(root, "LICENSE"), path.join(cli, "LICENSE"))
  await Bun.write(
    path.join(cli, "README.md"),
    `# SubiCode\n\n${manifest.version} for ${target.vscode}. Run \`subi\` in your project directory.\n`,
  )
  await Bun.write(
    path.join(cli, "package.json"),
    JSON.stringify(
      {
        name: "@learnsmart/subi-cli",
        version: manifest.version,
        description: "SubiCode terminal client",
        license: "MIT",
        homepage: "https://stlearnsmart.in/subi-code",
        bin: { subi: "bin/subi.cjs" },
        engines: { node: ">=22.0.0" },
        os: [platform],
        cpu: [arch],
        files: ["bin", "LICENSE", "README.md"],
      },
      null,
      2,
    ) + "\n",
  )

  await mkdir(path.join(extension, "bin", target.vscode), { recursive: true })
  const extensionSource = path.join(root, "sdks/vscode")

  for (const file of ["dist", "images", "LICENSE", "README.md"])
    await cp(path.join(extensionSource, file), path.join(extension, file), { recursive: true })
  const vscode = await Bun.file(path.join(extensionSource, "package.json")).json()
  delete vscode.scripts
  delete vscode.devDependencies
  await Bun.write(path.join(extension, "package.json"), JSON.stringify(vscode, null, 2) + "\n")
  await copyFile(executable, path.join(extension, "bin", target.vscode, target.binary))
  await chmod(path.join(extension, "bin", target.vscode, target.binary), 0o755)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  await Bun.write(
    path.join(output, "qualification.json"),
    JSON.stringify(
      {
        version: manifest.version,
        extensionVersion: vscode.version,
        platform: target.vscode,
        cliSha256: sha256,
        nativeExecution: "pending",
        desktopExecution: "pending",
        extensionExecution: "pending",
      },
      null,
      2,
    ) + "\n",
  )

  return { cli, extension, target, version: manifest.version }
}
