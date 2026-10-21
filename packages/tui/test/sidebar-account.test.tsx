import { expect, test } from "bun:test"
import type { LearnSmartAccount } from "@opencode/schema/learnsmart-account"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test.each(["individual", "school"] as const)(
  "sidebar shows authoritative %s balance and clears it during refresh and signout",
  async (accountType) => {
    const location = { directory }
    const session = {
      id: "ses_balance",
      title: "Account sidebar",
      projectID: "proj_test",
      location,
      agent: "build",
      model: { providerID: "learnsmart", id: "coding" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    }
    let output: LearnSmartAccount.Snapshot = {
      status: "allowed",
      accountType,
      quotaMode: accountType === "school" ? "school_tokens" : "individual_credits",
      models: [],
      monthlyLimit: { configured: true, monthlyTokenLimit: 100_000 },
      usage: { status: "ready", usedTokens: 1200, remainingTokens: 98_800 },
      credits: {
        health: "healthy",
        totalAvailableMilli: 80_000,
        monthlyGrantMilli: 100_000,
        monthlyRemainingMilli: 60_000,
        rolloverRemainingMilli: 5_000,
        purchasedRemainingMilli: 15_000,
        reservedMilli: null,
        cycleEndsAtMs: null,
      },
      subscription: { active: true, renewalDateMs: null },
      inferenceAvailable: true,
    }
    let pending: Promise<Response> | undefined
    let requests = 0
    await using setup = await createAppFixture({
      width: 160,
      height: 45,
      args: { sessionID: session.id },
      config: { animations: false, tabs: { mode: "off" } },
      fetch: (url) => {
        if (url.pathname === "/api/session")
          return json({ data: url.searchParams.get("parentID") === session.id ? [] : [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message` || /\/inbox$/.test(url.pathname))
          return json({ data: [], cursor: {} })
        if (url.pathname === "/api/agent")
          return json({ location, data: [{ id: "build", name: "Build", mode: "primary", native: true }] })
        if (url.pathname === "/api/provider")
          return json({ location, data: [{ id: "learnsmart", name: "LearnSmart" }] })
        if (url.pathname === "/api/model")
          return json({
            location,
            data: [
              {
                id: "coding",
                modelID: "coding",
                providerID: "learnsmart",
                name: "Coding model",
                status: "active",
                variants: [],
                cost: [],
                time: { released: 0 },
              },
            ],
          })
        if (url.pathname === "/api/integration")
          return json({
            location,
            data: [
              {
                id: "learnsmart",
                name: "LearnSmart",
                methods: [],
                connections: [{ type: "credential", id: "cred_balance" }],
              },
            ],
          })
        if (url.pathname === "/api/rpc/subi.learnsmart.account/get") {
          requests++
          return pending ?? json({ output })
        }
      },
    })
    await setup.ready
    const balance = accountType === "school" ? "98,800 remaining" : "80 credits available"
    await setup.waitForFrame((frame) => frame.includes(balance))
    expect(setup.captureCharFrame()).not.toContain(accountType === "school" ? "credits available" : "School tokens")
    const reply = Promise.withResolvers<Response>()
    pending = reply.promise
    try {
      const lines = setup.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes("Refresh"))
      await setup.mockMouse.click(lines[row].indexOf("Refresh") + 2, row)
      await setup.waitForFrame((frame) => frame.includes("Loading balance"))
      expect(setup.captureCharFrame()).not.toContain(balance)
      output = {
        status: "idle",
        models: [],
        monthlyLimit: { configured: false, monthlyTokenLimit: null },
        usage: { status: "idle" },
        inferenceAvailable: false,
      }
      pending = undefined
      setup.events.emit({
        id: "evt_sidebar_signout",
        created: 1,
        type: "credential.switched",
        data: { integrationID: "learnsmart", credentialID: null },
      })
      await setup.waitForFrame((frame) => frame.includes("Account idle"))
      reply.resolve(
        json({
          output: {
            ...output,
            status: "allowed",
            accountType: "individual",
            quotaMode: "individual_credits",
            credits: { health: "healthy", totalAvailableMilli: 999_000 },
          },
        }),
      )
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain(balance)
      expect(setup.captureCharFrame()).not.toContain("999 credits")
      expect(requests).toBeGreaterThanOrEqual(3)
    } finally {
      reply.resolve(json({ output }))
    }
  },
)
