import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { distributionTarget, stageDistribution, stageNpmWrapper } from "./distribution-packages"

// A missing/incorrect bundled binary used to go unnoticed in non-Windows VSIXs.
test.each([
  ["win32", "x64", "cli-windows-x64-baseline"],
  ["win32", "arm64", "cli-windows-arm64"],
  ["linux", "x64", "cli-linux-x64-baseline"],
  ["linux", "arm64", "cli-linux-arm64"],
  ["darwin", "x64", "cli-darwin-x64-baseline"],
  ["darwin", "arm64", "cli-darwin-arm64"],
])("stages the %s/%s native binary into both packages", async (platform, arch, directory) => {
  const root = await mkdtemp(path.join(tmpdir(), "subicode-package-"))

  try {
    await mkdir(path.join(root, "packages/cli/bin"), { recursive: true })
    await Bun.write(
      path.join(root, "packages/cli/bin/opencode.cjs"),
      await Bun.file(path.resolve(import.meta.dirname, "../../cli/bin/opencode.cjs")).text(),
    )
    await Bun.write(path.join(root, "LICENSE"), "MIT")

    for (const file of ["dist/extension.js", "images/icon.png", "LICENSE", "README.md"])
      await Bun.write(path.join(root, "sdks/vscode", file), file)
    await Bun.write(
      path.join(root, "sdks/vscode/package.json"),
      JSON.stringify({
        name: "subicode",
        version: "2.0.1",
        scripts: { package: "build" },
        devDependencies: { typescript: "*" },
      }),
    )
    const target = distributionTarget(platform, arch)
    const source = path.join(root, "dist", directory)
    await Bun.write(
      path.join(source, "package.json"),
      JSON.stringify({ version: "2.0.0-dev.30", os: [platform], cpu: [arch] }),
    )
    const bytes = Buffer.alloc(256)

    if (platform === "win32") {
      bytes.write("MZ")
      bytes.writeUInt32LE(0x80, 0x3c)
      bytes.writeUInt32LE(0x4550, 0x80)
      bytes.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 0x84)
    }

    if (platform === "linux") {
      bytes.write("\x7fELF")
      bytes[4] = 2
      bytes[5] = 1
      bytes[6] = 1
      bytes.writeUInt16LE(arch === "x64" ? 62 : 183, 18)
      bytes.writeUInt32LE(1, 20)
    }

    if (platform === "darwin") {
      bytes.writeUInt32LE(0xfeedfacf)
      bytes.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4)
      bytes.writeUInt32LE(2, 12)
    }

    await Bun.write(path.join(source, "bin", target.binary), bytes)
    const output = path.join(root, "packages-out")
    const staged = await stageDistribution(root, path.join(root, "dist"), output, platform, arch)
    expect(await Bun.file(path.join(staged.cli, "bin", target.binary)).arrayBuffer()).toEqual(bytes.buffer)
    expect(
      await Bun.file(path.join(staged.extension, "bin", `${platform}-${arch}`, target.binary)).arrayBuffer(),
    ).toEqual(bytes.buffer)
    expect(await Bun.file(path.join(staged.cli, "package.json")).json()).toMatchObject({
      name: `@subicodeagent/subi-cli-${platform}-${arch}`,
      os: [platform],
      cpu: [arch],
      version: "2.0.0-dev.30",
      bin: { subi: "bin/subi.cjs" },
    })
    expect(await Bun.file(path.join(staged.extension, "package.json")).json()).not.toHaveProperty("scripts")
    await expect(stageDistribution(root, path.join(root, "dist"), output, platform, arch)).rejects.toThrow()

    const machineOffset = new Map([
      ["win32", 0x84],
      ["linux", 18],
      ["darwin", 4],
    ]).get(platform)!

    if (platform === "darwin") bytes.writeUInt32LE(arch === "x64" ? 0x0100000c : 0x01000007, machineOffset)

    if (platform === "linux") bytes.writeUInt16LE(arch === "x64" ? 183 : 62, machineOffset)

    if (platform === "win32") bytes.writeUInt16LE(arch === "x64" ? 0xaa64 : 0x8664, machineOffset)
    await Bun.write(path.join(source, "bin", target.binary), bytes)
    await expect(
      stageDistribution(root, path.join(root, "dist"), path.join(root, "wrong-native"), platform, arch),
    ).rejects.toThrow("must contain only")
    await Bun.write(
      path.join(source, "package.json"),
      JSON.stringify({ version: "2.0.0", os: [platform], cpu: [arch === "x64" ? "arm64" : "x64"] }),
    )
    await expect(
      stageDistribution(root, path.join(root, "dist"), path.join(root, "wrong"), platform, arch),
    ).rejects.toThrow("CLI manifest does not match")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects unsupported distributions instead of falling back to an x64 binary", () => {
  expect(() => distributionTarget("linux", "ia32")).toThrow("Unsupported SubiCode distribution")
})

test("public npm launcher has identical text across Windows and Unix build hosts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "subicode-npm-wrapper-"))
  try {
    await Bun.write(
      path.join(root, "sdks/npm/package.json"),
      JSON.stringify({ name: "@subicodeagent/subi-cli", version: "0.0.0" }),
    )
    for (const file of ["sdks/npm/bin/subi.cjs", "sdks/npm/README.md", "LICENSE"])
      await Bun.write(path.join(root, file), "first line\r\nsecond line\r\n")
    const output = await stageNpmWrapper(root, path.join(root, "wrapper"), "2.0.0")
    for (const file of ["bin/subi.cjs", "README.md", "LICENSE"])
      expect(await Bun.file(path.join(output, file)).text()).toBe("first line\nsecond line\n")
    const manifest = await Bun.file(path.join(output, "package.json")).json()
    expect(manifest.version).toBe("2.0.0")
    expect(Object.keys(manifest.optionalDependencies)).toHaveLength(6)
    expect(new Set(Object.values(manifest.optionalDependencies))).toEqual(new Set(["2.0.0"]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
