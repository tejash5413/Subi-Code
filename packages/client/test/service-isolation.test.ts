import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { Service } from "../src/promise/service"
import { discover } from "../src/effect/service"

test("both clients discover only SUBI's default service and leave an upstream registration untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "subi-client-isolation-"))
  const previous = process.env.XDG_STATE_HOME
  const requests: string[] = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return Response.json({ version: "test", pid: process.pid })
    },
  })
  const registration = JSON.stringify({ url: server.url.toString(), pid: process.pid, version: "test" })
  const upstream = join(root, "opencode", "service.json")
  const own = join(root, "subi-code", "service.json")

  try {
    process.env.XDG_STATE_HOME = root
    await mkdir(join(root, "opencode"))
    await writeFile(upstream, registration)
    expect(await Service.discover()).toBeUndefined()
    expect(await Effect.runPromise(discover().pipe(Effect.provide(NodeFileSystem.layer)))).toBeUndefined()
    expect(requests).toEqual([])

    await mkdir(join(root, "subi-code"))
    await writeFile(own, registration)
    expect(await Service.discover()).toEqual({ url: server.url.toString(), auth: undefined })
    expect(await Effect.runPromise(discover().pipe(Effect.provide(NodeFileSystem.layer)))).toEqual({
      url: server.url.toString(),
      auth: undefined,
    })
    expect(requests).toEqual(["/api/info", "/api/info"])
    expect(await Bun.file(upstream).text()).toBe(registration)
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
