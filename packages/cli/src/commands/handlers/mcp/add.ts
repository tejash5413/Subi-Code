import { EOL } from "node:os"
import path from "node:path"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { Effect, Option } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.mcp.commands.add,
  Effect.fn("cli.mcp.add")(function* (input) {
    const url = Option.getOrUndefined(input.url)
    const headers = Option.getOrUndefined(input.header)
    const environment = Option.getOrUndefined(input.env)
    const clientID = Option.getOrUndefined(input.clientID)
    const scope = Option.getOrUndefined(input.scope)
    // The CLI framework strands `--` operands on the root command, so read the local server command
    // straight from argv after `--`. This also lets the command carry its own flags (e.g. `npx -y`).
    const dash = process.argv.indexOf("--")
    const command = dash === -1 ? [...input.command] : process.argv.slice(dash + 1)

    const hasCommand = command.length > 0
    if (url && hasCommand)
      return yield* Effect.fail(new Error("Provide either --url <url> or a command after --, not both"))
    if (!url && !hasCommand) return yield* Effect.fail(new Error("Provide either --url <url> or a command after --"))
    if (
      url &&
      (!URL.canParse(url) ||
        !["http:", "https:"].includes(new URL(url).protocol) ||
        new URL(url).username ||
        new URL(url).password)
    )
      return yield* Effect.fail(
        new Error("Remote MCP servers require an HTTP or HTTPS URL without embedded credentials"),
      )
    if (url && environment) return yield* Effect.fail(new Error("--env is only valid for local MCP servers"))
    if (hasCommand && headers) return yield* Effect.fail(new Error("--header is only valid for remote MCP servers"))
    if (hasCommand && (input.auth || clientID || scope))
      return yield* Effect.fail(new Error("--auth, --client-id and --scope are only valid for remote MCP servers"))

    const server = url
      ? {
          type: "remote" as const,
          url,
          ...(headers ? { headers } : {}),
          ...(clientID || scope
            ? { oauth: { ...(clientID ? { client_id: clientID } : {}), ...(scope ? { scope } : {}) } }
            : {}),
        }
      : { type: "local" as const, command, ...(environment ? { environment } : {}) }

    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(input.global ? global.config : process.cwd()))
    yield* Effect.promise(() => write(configPath, input.name, server))
    process.stdout.write(
      `MCP server "${input.name}" saved in your ${input.global ? "global" : "project"} SubiCode configuration` + EOL,
    )
    if (!input.auth) return
    const { OpenCode } = yield* Effect.promise(() => import("@opencode/client"))
    const { Service } = yield* Effect.promise(() => import("@opencode/client/effect/service"))
    const { ServerConnection } = yield* Effect.promise(() => import("../../../services/server-connection"))
    const { authenticateMcp } = yield* Effect.promise(() => import("./auth"))
    const { request } = yield* Effect.promise(() => import("../auth/shared"))
    const { endpoint } = yield* ServerConnection.resolve()
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const location = { directory: process.cwd() }
    if (input.global) {
      yield* request((signal) => client.config.update({ mcp: { [input.name]: server } }, { signal }))
      // Global connections belong to durable config, without a runtime override that would
      // survive an Edit/Remove action in Settings. Wait for config discovery before connecting.
      yield* Effect.gen(function* () {
        while (true) {
          const entries = yield* request((signal) => client.config.get({}, { signal }))
          const loaded = entries.some((entry) => {
            if (entry.type !== "document") return false
            const config = entry.info.mcp?.servers?.[input.name]
            return config?.type === "remote" && config.url === url
          })
          const list = yield* request((signal) => client.mcp.list({ location }, { signal }))
          if (loaded && list.data.some((item) => item.name === input.name)) return
          yield* Effect.sleep(100)
        }
      }).pipe(Effect.timeout("15 seconds"))
    } else {
      yield* request((signal) => client.mcp.add({ server: input.name, config: server, location }, { signal }))
    }
    // Explicit connect waits for the handshake before deciding whether sign-in is needed.
    yield* request((signal) => client.mcp.connect({ server: input.name, location }, { signal }))
    const connected = yield* request((signal) => client.mcp.list({ location }, { signal }))
    const status = connected.data.find((item) => item.name === input.name)?.status
    if (status?.status === "connected") {
      process.stdout.write(`MCP server "${input.name}" connected` + EOL)
      return
    }
    if (status?.status === "failed") return yield* Effect.fail(new Error(status.error))
    yield* authenticateMcp(input.name)
  }),
)

export async function resolveConfigPath(directory: string) {
  const candidates = [
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
  ]
  for (const candidate of candidates) {
    if (
      await stat(candidate).then(
        (info) => info.isFile(),
        () => false,
      )
    )
      return candidate
  }
  return candidates[0]
}

async function write(configPath: string, name: string, server: unknown) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}"
    throw error
  })
  const edits = modify(text, ["mcp", "servers", name], server, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, applyEdits(text, edits))
}
