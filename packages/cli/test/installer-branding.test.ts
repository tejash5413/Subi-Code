import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { isolatedEnv } from "./fixture/environment"

test("local installer owns only the Subi command and refuses an unconfigured download feed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subi-brand-install-"))
  const portable = root.replaceAll("\\", "/")
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash"
  const script = path.resolve(import.meta.dirname, "../../../install").replaceAll("\\", "/")
  const env = {
    ...isolatedEnv(root),
    HOME: portable,
    XDG_CONFIG_HOME: portable + "/config",
    SHELL: "/bin/bash",
    PATH: process.env.PATH,
  }
  const run = async (args: string[]) => {
    const child = Bun.spawn([bash, script, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output: stdout + stderr }
  }
  try {
    // Keep any accidental upstream request inside the disposable fixture.
    await mkdir(path.join(root, "mock-bin"))
    await Bun.write(
      path.join(root, "mock-bin/curl"),
      `#!/bin/sh\nprintf attempted > '${portable}/network-called'\nexit 87\n`,
    )
    const shellPath = process.platform === "win32" ? "/usr/bin:/bin" : process.env.PATH!
    env.PATH = portable + "/mock-bin:" + shellPath
    const denied = await run(["--no-modify-path"])
    expect(denied.code).toBe(1)
    expect(denied.output).toContain("Subi Code download feed is not configured")
    expect(await Bun.file(path.join(root, "network-called")).exists()).toBe(false)
    const binary = path.join(root, "verified-subi.exe")
    await Bun.write(binary, "verified-local-binary")
    const installed = await run(["--binary", binary.replaceAll("\\", "/"), "--no-modify-path"])
    expect(installed.code, installed.output).toBe(0)
    expect(installed.output).toContain("Subi Code installed")
    expect(installed.output).not.toContain("OpenCode")
    expect(
      await Bun.file(path.join(root, ".subi-code/bin", process.platform === "win32" ? "subi.exe" : "subi")).text(),
    ).toBe("verified-local-binary")
    expect(await Bun.file(path.join(root, ".opencode/bin/opencode")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, ".subi-code/bin/opencode2.cmd")).exists()).toBe(false)
  } finally {
    if (!root.startsWith(path.join(os.tmpdir(), "subi-brand-install-"))) throw new Error("Unexpected temporary root")
    await rm(root, { recursive: true, force: true })
  }
})
