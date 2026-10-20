import { afterEach, expect, test } from "bun:test"
import { getConfig } from "../electron-builder.config"
import { downloadCliToResources } from "./utils"

const channel = process.env.OPENCODE_CHANNEL

afterEach(() => {
  if (channel === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = channel
})

test.each([
  ["dev", "in.stlearnsmart.subi.desktop.dev", "SubiCode"],
  ["beta", "in.stlearnsmart.subi.desktop.beta", "SubiCode"],
  ["prod", "in.stlearnsmart.subi.desktop", "SubiCode"],
])("isolates the %s desktop identity and update channel", (channel, appId, productName) => {
  process.env.OPENCODE_CHANNEL = channel
  const config = getConfig()
  expect(config.appId).toBe(appId)
  expect(config.productName).toBe(productName)
  expect(config.protocols).toMatchObject({ schemes: ["subi"] })
  expect(config.publish ?? null).toBeNull()
  expect(config.artifactName).toBe("subi-desktop-${os}-${arch}.${ext}")
})

test("rejects replacing the SUBI server with a published upstream CLI", async () => {
  await expect(downloadCliToResources()).rejects.toThrow(
    "Build the SUBI CLI locally; upstream OpenCode binaries are not SUBI builds",
  )
})
