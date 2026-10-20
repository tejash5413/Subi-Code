import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test.each([100, 44])("model picker refreshes assignments at %s columns without duplicate requests", async (width) => {
  const pending = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  let requests = 0
  let available = false
  let fail = false
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  await using setup = await createAppFixture({
    width,
    height: 35,
    config: { animations: false, keybinds: { "model.list": "f8" } },
    fetch: (url) => {
      if (url.pathname === "/api/integration")
        return json({
          location,
          data: [
            {
              id: "learnsmart",
              name: "LearnSmart",
              methods: [],
              connections: [{ type: "credential", id: "cred_fixture" }],
            },
          ],
        })
      if (url.pathname === "/api/rpc/subi.learnsmart.account/get") {
        requests++
        requested.resolve()
        return fail
          ? json({ error: "unavailable" }, { status: 503 })
          : pending.promise.then((response) => response.clone())
      }
      if (url.pathname === "/api/provider")
        return json({ location, data: available ? [{ id: "learnsmart", name: "LearnSmart" }] : [] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: available
            ? [
                {
                  id: "assigned",
                  modelID: "assigned",
                  providerID: "learnsmart",
                  name: "Assigned coding model",
                  status: "active",
                  variants: [],
                  cost: [],
                  time: { released: 0 },
                },
              ]
            : [],
        })
    },
  })
  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("commands"))
    setup.mockInput.pressKey("F8")
    await setup.waitForFrame(
      (frame) => frame.includes("Select model") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
    )
    expect(setup.captureCharFrame()).toContain("No items available")
    expect(setup.captureCharFrame()).toContain("Refresh")
    expect(setup.captureCharFrame()).toContain("ctrl+r")
    setup.mockInput.pressKey("r", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Refreshing"))
    await requested.promise
    expect(requests).toBe(1)
    setup.mockInput.pressKey("r", { ctrl: true })
    await setup.renderOnce()
    expect(requests).toBe(1)
    available = true
    pending.resolve(
      json({
        output: {
          status: "allowed",
          models: [],
          monthlyLimit: { configured: false, monthlyTokenLimit: null },
          usage: { status: "idle" },
          inferenceAvailable: true,
        },
      }),
    )
    await setup.waitForFrame((frame) => frame.includes("Assigned coding model") && !frame.includes("Refreshing"))
    expect(setup.captureCharFrame()).toContain("Select model")
    fail = true
    setup.mockInput.pressKey("r", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Unable to refresh models"))
    expect(requests).toBe(2)
    expect(setup.captureCharFrame()).toContain("Assigned coding model")
    fail = false
    setup.mockInput.pressKey("r", { ctrl: true })
    await setup.waitFor(() => requests === 3)
    await setup.waitForFrame((frame) => frame.includes("Refresh") && !frame.includes("Refreshing"))
  } finally {
    pending.resolve(
      json({
        output: {
          status: "idle",
          models: [],
          monthlyLimit: { configured: false, monthlyTokenLimit: null },
          usage: { status: "idle" },
          inferenceAvailable: false,
        },
      }),
    )
  }
})

test("model picker refreshes BYOK catalogs without a LearnSmart request and preserves the search", async () => {
  let available = false
  let reads = 0
  let managedRequests = 0
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  await using setup = await createAppFixture({
    config: { animations: false, keybinds: { "model.list": "f8" } },
    fetch: (url) => {
      if (url.pathname === "/api/integration")
        return json({
          location,
          data: [{ id: "demo", name: "BYOK", methods: [], connections: [{ type: "credential", id: "cred_byok" }] }],
        })
      if (url.pathname === "/api/rpc/subi.learnsmart.account/get") {
        managedRequests++
        return json({ error: "unexpected" }, { status: 500 })
      }
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "BYOK" }] })
      if (url.pathname === "/api/model") {
        reads++
        return json({
          location,
          data: (available ? ["Coding replacement", "Other hidden"] : []).map((name) => ({
            id: name,
            modelID: name,
            providerID: "demo",
            name,
            status: "active",
            variants: [],
            cost: [],
            time: { released: 0 },
          })),
        })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("F8")
  await setup.waitForFrame(
    (frame) => frame.includes("Select model") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Coding")
  await setup.waitFor(() => reads > 0)
  const before = reads
  available = true
  setup.mockInput.pressKey("r", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Coding replacement"))
  expect(setup.captureCharFrame()).not.toContain("Other hidden")
  expect(reads).toBe(before + 1)
  expect(managedRequests).toBe(0)
})
