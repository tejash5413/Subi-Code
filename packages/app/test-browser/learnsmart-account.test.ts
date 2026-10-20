import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("LearnSmart billing UI refreshes confirmed balances and discards switched-account requests", async () => {
  // Keep context port substitutions isolated, as in the model-selection keeper.
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/learnsmart-account.ts",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(status, stdout + stderr).toBe(0)
}, 30_000)
