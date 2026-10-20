import { expect, test } from "bun:test"
import path from "node:path"
import type { IntegrationInfo, McpServer } from "@opencode/client"
import { mcpAuthChoices } from "../src/commands/handlers/mcp/auth"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"
import { ServiceConfig } from "../src/services/service-config"

const server = (
  name: string,
  integrationID?: string,
  status: McpServer["status"] = { status: "pending" },
): McpServer => ({ name, integrationID, status })

const integration = (id: string, methods: IntegrationInfo["methods"], connected = false): IntegrationInfo => ({
  id,
  name: id,
  methods,
  connections: connected ? [{ type: "credential", method: "oauth", id: "cred_1", label: "Work" }] : [],
})

test("offers only OAuth-capable MCP servers by their server identity", () => {
  expect(
    mcpAuthChoices(
      [
        server("Linear", "mcp_linear", { status: "needs_auth", error: "expired" }),
        server("Local"),
        server("API key only", "mcp_key"),
        server("GitHub", "mcp_github"),
        server("Sentry", "mcp_sentry", { status: "failed", error: "boom" }),
        server("Unresolved", "mcp_missing"),
      ],
      [
        integration("mcp_linear", [{ type: "oauth", id: "login", label: "Linear" }], true),
        integration("mcp_github", [{ type: "oauth", id: "login", label: "GitHub" }]),
        integration("mcp_sentry", [{ type: "oauth", id: "login", label: "Sentry" }]),
        integration("mcp_key", [{ type: "key" }]),
        integration("Linear", [{ type: "oauth", id: "login", label: "A provider with a colliding name" }]),
      ],
    ),
  ).toEqual([
    { value: "mcp_github", label: "GitHub", category: "MCP", connected: false, hint: undefined },
    { value: "mcp_linear", label: "Linear", category: "MCP", connected: true, hint: "needs authentication" },
    { value: "mcp_sentry", label: "Sentry", category: "MCP", connected: false, hint: "failed" },
  ])
})

test("mcp auth accepts an optional server name and rejects no-name noninteractive calls before connecting", async () => {
  const cli = (args: string[]) =>
    Bun.spawn([process.execPath, "run", "src/index.ts", "mcp", "auth", ...args], {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
  const help = cli(["--help"])
  expect(await new Response(help.stdout).text()).toContain("subi mcp auth [flags] [<name>]")
  expect(await help.exited).toBe(0)

  const missing = cli([])
  expect(await new Response(missing.stdout).text()).toContain(
    "Pass an MCP server name when running without an interactive terminal",
  )
  expect(await new Response(missing.stderr).text()).toBe("")
  expect(await missing.exited).toBe(1)
})

test("mcp add saves a remote SubiCode client configuration and rejects non-HTTP endpoints", async () => {
  await using tmp = await tmpdir("subicode-cli-mcp-")
  const cli = async (url: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/index.ts",
        "mcp",
        "add",
        "Docs",
        "--global",
        "--url",
        url,
        "--client-id",
        "subicode-client",
        "--scope",
        "read",
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: { ...process.env, OPENCODE_CONFIG_DIR: tmp.path },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    return {
      code: await child.exited,
      output: (await new Response(child.stdout).text()) + (await new Response(child.stderr).text()),
    }
  }
  const invalid = await cli("file:///private")
  expect(invalid.code).toBe(1)
  expect(invalid.output).toContain("HTTP or HTTPS")
  const added = await cli("https://docs.example.test/mcp")
  expect(added.code).toBe(0)
  expect(added.output).toContain("global SubiCode configuration")
  expect(await Bun.file(path.join(tmp.path, "opencode.json")).json()).toMatchObject({
    mcp: {
      servers: {
        Docs: {
          type: "remote",
          url: "https://docs.example.test/mcp",
          oauth: { client_id: "subicode-client", scope: "read" },
        },
      },
    },
  })
})

test("mcp add --auth waits for an open MCP server instead of starting unnecessary OAuth", async () => {
  await using tmp = await tmpdir("subicode-cli-mcp-connect-")
  let initialized = 0
  const endpoint = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const message = await request.json()
      if (message.id === undefined) return new Response(null, { status: 202 })
      if (message.method === "initialize") initialized++
      return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "Docs", version: "1" } }
        : message.method === "tools/list" ? { tools: [] } : {} })
    },
  })
  const env = isolatedEnv(tmp.path)
  await Bun.write(path.join(env.OPENCODE_CONFIG_DIR, ServiceConfig.filename()), JSON.stringify({ disabled: true }))
  try {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "mcp", "add", "Docs", "--global", "--url", endpoint.url.href, "--auth"], {
      cwd: path.join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
    })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(0)
    expect(output).toContain('MCP server "Docs" connected')
    expect(output).not.toContain("Starting authorization")
    expect(errors).not.toContain("InvalidRequestError")
    expect(initialized).toBeGreaterThan(0)
  } finally {
    endpoint.stop(true)
  }
})
