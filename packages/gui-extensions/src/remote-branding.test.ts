import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { RemoteCli } from "./ssh/remote-cli"
import { discoverScript, installScript, quote } from "./wsl/remote-cli"

test("remote discovery ignores a separate OpenCode install and WSL stages only the supplied Subi build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subi-remote-brand-"))
  const home = root.replaceAll("\\", "/")
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash"

  const run = async (script: string) => {
    const child = Bun.spawn([bash, "-s"], {
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
      stdin: new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
    })

    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    return { code, stdout, stderr }
  }

  try {
    await mkdir(path.join(root, ".opencode/bin"), { recursive: true })
    const old = path.join(root, ".opencode/bin/opencode")
    await Bun.write(old, "#!/bin/sh\necho old-upstream\n")
    await run(`chmod +x ${quote(old.replaceAll("\\", "/"))}`)

    for (const script of [discoverScript(), RemoteCli.discoverScript()]) {
      expect((await run(script)).stdout).toBe("")
    }

    const denied = await run(installScript({ version: "2.0.0-dev.16" }))
    expect(denied.code).not.toBe(0)
    expect(denied.stderr).toContain("Subi Code download feed is not configured")
    const binary = path.join(root, "verified-subi")
    await Bun.write(binary, "#!/bin/sh\necho 'Subi Code v2.0.0-dev.16'\n")
    const installed = await run(installScript({ version: "2.0.0-dev.16", binary: quote(binary.replaceAll("\\", "/")) }))
    expect(installed.code, installed.stderr).toBe(0)
    const found = await run(discoverScript())

    const native =
      process.platform === "win32"
        ? (await run(`cygpath -m ${quote(found.stdout.trim())}`)).stdout.trim()
        : found.stdout.trim()

    expect(path.resolve(native)).toBe(path.join(root, ".subi-code/bin/subi"))
    expect(await Bun.file(old).text()).toContain("old-upstream")

    await Bun.write(binary, "#!/bin/sh\necho 'Subi Code v0.0.0-wrong'\n")

    const stale = await run(installScript({ version: "2.0.0-dev.16", binary: quote(binary.replaceAll("\\", "/")) }))

    expect(stale.code).not.toBe(0)
    expect(await Bun.file(path.join(root, ".subi-code/bin/subi")).text()).toContain("Subi Code v2.0.0-dev.16")
  } finally {
    if (!root.startsWith(path.join(os.tmpdir(), "subi-remote-brand-"))) throw new Error("Unexpected temporary root")
    await rm(root, { recursive: true, force: true })
  }
})
