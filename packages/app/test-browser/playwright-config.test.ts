import { expect, test } from "bun:test"
import type { PlaywrightTestConfig } from "@playwright/test"
import { createRequire } from "node:module"

const configFiles = [
  "./playwright.config.ts",
  "./e2e/performance/playwright.config.ts",
  "./e2e/performance/playwright.uncapped.config.ts",
  "./e2e/performance/timeline-stability/playwright.config.ts",
]

const modules = createRequire(import.meta.url)

async function load(file: string, environment: Record<string, string | undefined>) {
  const keys = [
    ...new Set([
      ...Object.keys(environment),
      "PLAYWRIGHT_SERVER_HOST",
      "PLAYWRIGHT_SERVER_PORT",
      "OPENCODE_PERFORMANCE_RUN_ID",
    ]),
  ]

  const previous = new Map(keys.map((key) => [key, process.env[key]]))

  const cached = new Map(
    configFiles.map((entry) => {
      const key = modules.resolve(`../${entry}`)

      return [key, modules.cache[key]] as const
    }),
  )

  try {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]

      if (value !== undefined) process.env[key] = value
    }

    // Bun caches file imports independently of URL queries. Reevaluate the actual config and its config-only imports.
    for (const key of cached.keys()) delete modules.cache[key]
    const module: { default: PlaywrightTestConfig } = await import(new URL(`../${file}`, import.meta.url).href)

    return {
      config: module.default,
      fixtureHost: process.env.PLAYWRIGHT_SERVER_HOST,
      fixturePort: process.env.PLAYWRIGHT_SERVER_PORT,
    }
  } finally {
    for (const [key, value] of cached) {
      if (value === undefined) delete modules.cache[key]

      if (value !== undefined) modules.cache[key] = value
    }

    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]

      if (value !== undefined) process.env[key] = value
    }
  }
}

test.each([
  { name: "local development", ci: "", build: "", built: false },
  { name: "local production build", ci: "", build: "1", built: true },
  { name: "CI production build", ci: "true", build: "", built: true },
  { name: "CI cannot opt into development", ci: "true", build: "0", built: true },
])("Playwright uses $name", async ({ ci, build, built }) => {
  const { config } = await load("playwright.config.ts", {
    CI: ci,
    PLAYWRIGHT_BUILD: build,
    PLAYWRIGHT_BASE_URL: undefined,
    PLAYWRIGHT_PORT: "4321",
    PLAYWRIGHT_SERVER_HOST: "127.0.0.2",
    PLAYWRIGHT_SERVER_PORT: "4322",
  })

  const server = config.webServer

  if (!server || Array.isArray(server)) throw new Error("Expected one managed app server")
  expect(config.use?.baseURL).toBe("http://127.0.0.1:4321")
  expect(server.url).toBe(config.use?.baseURL)
  expect(server.command).toBe(
    built
      ? "bun run build && bun e2e/utils/serve.ts --host 127.0.0.1 --port 4321"
      : "bun run dev -- --host 127.0.0.1 --port 4321 --strictPort",
  )
  expect(server.reuseExistingServer).toBe(!built)
  expect(server.env).toEqual({
    VITE_OPENCODE_TEST_FIXTURES: "1",
    VITE_OPENCODE_SERVER_HOST: built ? "127.0.0.1" : "127.0.0.2",
    VITE_OPENCODE_SERVER_PORT: built ? "4321" : "4322",
  })
})

test.each(configFiles)("%s leaves an explicit external app unmanaged", async (file) => {
  const result = await load(file, { CI: "true", PLAYWRIGHT_BASE_URL: "http://127.0.0.1:4444" })
  expect(result.config.webServer).toBeUndefined()
  expect(result.config.use?.baseURL).toBe("http://127.0.0.1:4444")
  expect(result.fixtureHost).toBe("127.0.0.1")
  expect(result.fixturePort).toBe("4444")
})

test("Playwright rejects HTTPS targets unsupported by the API fixtures", async () => {
  await expect(
    load("playwright.config.ts", { CI: "true", PLAYWRIGHT_BASE_URL: "https://e2e.example.com" }),
  ).rejects.toThrow("E2E fixtures require an http:// app URL")
})
