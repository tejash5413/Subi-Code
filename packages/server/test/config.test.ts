import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/schema/config"
import { Plugin } from "@opencode/schema/plugin"
import { Skill } from "@opencode/schema/skill"
import { Effect, Schedule, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode/schema/schema"

it.live("loads and removes a local plugin and skill after source patches without restarting", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("subicode-extension-sources-")))
    const global = path.join(tmp.path, "global")
    const plugin = path.join(tmp.path, "fixture-plugin")
    const skills = path.join(tmp.path, "fixture-skills")
    yield* Effect.promise(async () => {
      await fs.mkdir(global, { recursive: true })
      await fs.mkdir(skills)
      await fs.mkdir(plugin)
      await fs.writeFile(path.join(plugin, "package.json"), '{"type":"module"}')
      await fs.writeFile(
        path.join(plugin, "index.js"),
        'export default { id: "source-setup-fixture", async setup() {} }',
      )
      await fs.writeFile(
        path.join(skills, "SKILL.md"),
        "---\nname: source-setup-fixture\ndescription: Local setup fixture\n---\nLocal skill.",
      )
    })
    const server = yield* startServer(global)
    const endpoint = (pathname: string) => {
      const url = new URL(pathname, server.base)
      url.searchParams.set("location[directory]", tmp.path)
      return url
    }
    const inventory = Effect.gen(function* () {
      const [plugins, skills] = yield* Effect.promise(() =>
        Promise.all([
          fetch(endpoint("/api/plugin"), { headers: server.headers }).then((response) => response.json()),
          fetch(endpoint("/api/skill"), { headers: server.headers }).then((response) => response.json()),
        ]),
      )
      return {
        plugins: Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Plugin.Info) }))(plugins).data,
        skills: Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Skill.Info) }))(skills).data,
      }
    })
    yield* inventory
    const patch = (enabled: boolean) =>
      Effect.promise(() =>
        fetch(endpoint("/api/experimental/config"), {
          method: "PATCH",
          headers: { ...server.headers, "content-type": "application/json" },
          body: JSON.stringify({ plugins: { [plugin]: enabled ? {} : null }, skills: { [skills]: enabled } }),
        }),
      )
    let observed = ""
    for (const enabled of [true, false]) {
      expect((yield* patch(enabled)).status).toBe(204)
      const result = yield* inventory.pipe(
        Effect.flatMap((value) => {
          observed = JSON.stringify({
            plugins: value.plugins.filter((item) => item.source.type !== "builtin"),
            skills: value.skills,
          })
          const loaded = value.plugins.some(
            (item) => item.id === "source-setup-fixture" && item.state.status === "active",
          )
          const discovered = value.skills.some((item) => item.name === "source-setup-fixture")
          return loaded === enabled && discovered === enabled
            ? Effect.succeed(value)
            : Effect.fail("Waiting for source reload")
        }),
        Effect.retry({ schedule: Schedule.spaced("20 millis") }),
        Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.die(observed) }),
      )
      expect(result.plugins.some((item) => item.id === "source-setup-fixture")).toBe(enabled)
      expect(result.skills.some((item) => item.name === "source-setup-fixture")).toBe(enabled)
      if (enabled) {
        const reopened = yield* startServer(global)
        const url = new URL("/api/config", reopened.base)
        url.searchParams.set("location[directory]", tmp.path)
        const response = yield* Effect.promise(() => fetch(url, { headers: reopened.headers }))
        const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(yield* Effect.promise(() => response.json()))
        expect(entries.some(entry => entry.type === "document" && entry.info.plugins?.some(item => (typeof item === "string" ? item : item.package) === plugin))).toBe(true)
        expect(entries.some(entry => entry.type === "document" && entry.info.skills?.includes(skills))).toBe(true)
      }
    }
  }),
)

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("updates the global shell without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

it.live("patches plugin and skill sources without replacing sibling settings or reviving earlier definitions", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("subicode-extension-config-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global))
    const first = path.join(global, "opencode.json")
    const last = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() =>
      fs.writeFile(
        first,
        JSON.stringify({
          plugin: [["fixture-plugin", { old: true }]],
          skills: { paths: ["~/fixture-skills"], urls: ["https://example.com/skills/"] },
          shell: "bash",
        }),
      ),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        last,
        '{\n// keep source comments\n"plugins":["untouched-plugin",{"package":"fixture-plugin","options":{"current":true}}],"skills":["~/untouched-skills","~/fixture-skills"],"instructions":["AGENTS.md"]\n}\n',
      ),
    )
    const server = yield* startServer(global)
    const patch = (body: unknown) =>
      Effect.promise(() =>
        fetch(new URL("/api/experimental/config", server.base), {
          method: "PATCH",
          headers: { ...server.headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    expect(
      (yield* patch({
        plugins: { "fixture-plugin": { updated: true }, "new-plugin": {} },
        skills: { "~/new-skills": true },
      })).status,
    ).toBe(204)
    expect((yield* patch({ plugins: { "new-plugin": {} }, skills: { "~/new-skills": true } })).status).toBe(204)
    const read = (file: string) =>
      Effect.promise(async () => JSON.parse((await fs.readFile(file, "utf8")).replace("// keep source comments", "")))
    const added = yield* read(last)
    expect(added.plugins).toEqual([
      "untouched-plugin",
      { package: "fixture-plugin", options: { updated: true } },
      { package: "new-plugin", options: {} },
    ])
    expect(added.skills).toEqual(["~/untouched-skills", "~/fixture-skills", "~/new-skills"])
    expect(added.instructions).toEqual(["AGENTS.md"])
    expect(yield* Effect.promise(() => fs.readFile(last, "utf8"))).toContain("// keep source comments")
    expect(
      (yield* patch({
        plugins: { "fixture-plugin": null, "new-plugin": null },
        skills: { "~/fixture-skills": false, "~/new-skills": false, "https://example.com/skills/": false },
      })).status,
    ).toBe(204)
    const earlier = yield* read(first)
    const later = yield* read(last)
    expect(earlier.plugin).toEqual([])
    expect(earlier.skills).toEqual({ paths: [], urls: [] })
    expect(earlier.shell).toBe("bash")
    expect(later.plugins).toEqual(["untouched-plugin"])
    expect(later.skills).toEqual(["~/untouched-skills"])
  }),
)

it.live(
  "persists MCP edits without losing authentication, shell or JSONC comments, and removes earlier definitions",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("subicode-mcp-config-")))
      const global = path.join(tmp.path, "global")
      yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
      const config = path.join(global, "opencode.json")
      const later = path.join(global, "opencode.jsonc")
      yield* Effect.promise(() =>
        fs.writeFile(
          config,
          JSON.stringify({
            mcp: {
              servers: {
                docs: {
                  type: "remote",
                  url: "http://127.0.0.1:1/mcp",
                  disabled: true,
                  headers: { Authorization: "fixture-key" },
                  oauth: { client_id: "registered", client_secret: "fixture-secret" },
                },
              },
            },
          }),
        ),
      )
      yield* Effect.promise(() => fs.writeFile(later, '{\n// retain this comment\n"shell":"bash"\n}\n'))
      const server = yield* startServer(global)
      const patch = (body: Config.Patch) =>
        Effect.promise(() =>
          fetch(new URL("/api/experimental/config", server.base), {
            method: "PATCH",
            headers: { ...server.headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
      expect(
        (yield* patch({ mcp: { docs: { type: "remote", url: "http://127.0.0.1:2/mcp", disabled: true } } })).status,
      ).toBe(204)
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(config, "utf8"))).mcp.servers.docs).toEqual({
        type: "remote",
        url: "http://127.0.0.1:2/mcp",
        disabled: true,
        headers: { Authorization: "fixture-key" },
        oauth: { client_id: "registered", client_secret: "fixture-secret" },
      })
      expect(
        (yield* patch({
          mcp: { added: { type: "remote", url: "http://127.0.0.1:3/mcp", disabled: true, oauth: false } },
        })).status,
      ).toBe(204)
      const text = yield* Effect.promise(() => fs.readFile(later, "utf8"))
      expect(text).toContain("// retain this comment")
      expect(JSON.parse(text.replace("// retain this comment", "")).shell).toBe("bash")
      // A new server process reads the durable configuration without a runtime override.
      const restarted = yield* startServer(global)
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/config", restarted.base), { headers: restarted.headers }),
      )
      const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(yield* Effect.promise(() => response.json()))
      expect(entries.some((entry) => entry.type === "document" && entry.info.mcp?.servers?.added?.disabled)).toBe(true)
      expect((yield* patch({ mcp: { docs: null, added: null } })).status).toBe(204)
      for (const file of [config, later]) {
        const info = JSON.parse(
          (yield* Effect.promise(() => fs.readFile(file, "utf8"))).replace("// retain this comment", ""),
        )
        expect(info.mcp?.servers).not.toHaveProperty("docs")
        expect(info.mcp?.servers).not.toHaveProperty("added")
      }
      const tools = yield* Effect.promise(() =>
        fetch(new URL("/api/mcp/tool", server.base), { headers: server.headers }),
      )
      expect(tools.status).toBe(200)
      expect(yield* Effect.promise(() => tools.json())).toMatchObject({ data: [] })
    }),
)
