import { expect, test } from "bun:test"
import type { LearnSmartAccount } from "@opencode/schema/learnsmart-account"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

test.each([
  [100, "school"],
  [44, "individual"],
] as const)(
  "account page renders %s-column %s balances, refreshes and clears signed-out data",
  async (width, accountType) => {
    let output: LearnSmartAccount.Snapshot = {
      status: "allowed",
      accountType,
      quotaMode: accountType === "school" ? "school_tokens" : "individual_credits",
      models: [{ modelKey: "internal-assignment", displayName: "Assigned coding model", contextLength: 131_072 }],
      monthlyLimit: { configured: true, monthlyTokenLimit: accountType === "school" ? 100_000 : null },
      usage: { status: "ready", ...(accountType === "school" ? { usedTokens: 1200, remainingTokens: 98_800 } : {}) },
      ...(accountType === "individual"
        ? {
            credits: {
              health: "healthy",
              totalAvailableMilli: 80_000,
              monthlyGrantMilli: 100_000,
              monthlyRemainingMilli: 60_000,
              rolloverRemainingMilli: 5_000,
              purchasedRemainingMilli: 15_000,
              reservedMilli: null,
              cycleEndsAtMs: 1_800_000_000_000,
            },
          }
        : {}),
      subscription: { active: true, renewalDateMs: 1_800_000_000_000 },
      inferenceAvailable: false,
    }
    let requests = 0
    await using setup = await createAppFixture({
      width,
      height: 50,
      fetch: (url) => {
        if (url.pathname !== "/api/rpc/subi.learnsmart.account/get") return undefined
        requests++
        return json({ output })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("commands"))
    await setup.mockInput.typeText("/account")
    await setup.waitForFrame((frame) => frame.includes("LearnSmart account"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Assigned coding model"))
    expect(setup.captureCharFrame()).toContain("131,072")
    expect(setup.captureCharFrame()).not.toContain("internal-assignment")
    expect(setup.captureCharFrame()).toContain(accountType === "school" ? "98,800" : "80 credits")
    if (accountType === "individual") {
      expect(setup.captureCharFrame()).toContain("Rollover: 5")
      expect(setup.captureCharFrame()).toContain("Credit cycle ends:")
      expect(setup.captureCharFrame()).toContain("Top up credits")
      expect(setup.captureCharFrame()).toContain("Renew subscription")
    } else {
      expect(setup.captureCharFrame()).not.toContain("Top up credits")
      expect(setup.captureCharFrame()).not.toContain("Renew subscription")
    }
    expect(setup.captureCharFrame()).toContain("inference")
    expect(requests).toBe(1)

    output = { ...output, inferenceAvailable: true }
    setup.mockInput.pressKey("r")
    await setup.waitForFrame((frame) => frame.includes("model picker"))
    expect(setup.captureCharFrame()).not.toContain("inference is unavailable")

    if (accountType === "individual") {
      output = {
        ...output,
        status: "blocked",
        models: [],
        subscription: { active: false, renewalDateMs: 1_700_000_000_000 },
      }
      setup.mockInput.pressKey("r")
      await setup.waitForFrame((frame) => frame.includes("Subscription expired"))
      expect(setup.captureCharFrame()).toContain("Purchase or renew subscription")
      expect(setup.captureCharFrame()).not.toContain("Top up credits")
      expect(setup.captureCharFrame()).not.toContain("80 credits")
      output = {
        ...output,
        status: "allowed",
        subscription: { active: true, renewalDateMs: 1_800_000_000_000 },
        credits: { ...output.credits!, totalAvailableMilli: 180_000, purchasedRemainingMilli: 115_000 },
      }
      setup.mockInput.pressKey("r")
      await setup.waitForFrame((frame) => frame.includes("180 credits"))
      expect(setup.captureCharFrame()).toContain("115")
      output = {
        ...output,
        quotaMode: "school_tokens",
        monthlyLimit: { configured: true, monthlyTokenLimit: 100_000 },
        usage: { status: "ready", remainingTokens: 90_000 },
      }
      setup.mockInput.pressKey("r")
      await setup.waitForFrame((frame) => frame.includes("90,000"))
      expect(setup.captureCharFrame()).not.toContain("Top up credits")
      expect(setup.captureCharFrame()).not.toContain("Renew subscription")
    }

    output = {
      status: "unavailable",
      models: [],
      monthlyLimit: { configured: false, monthlyTokenLimit: null },
      usage: { status: "idle" },
      errorCode: "managed_timeout",
      inferenceAvailable: false,
    }
    setup.mockInput.pressKey("r")
    await setup.waitForFrame((frame) => frame.includes("managed_timeout"))
    expect(setup.captureCharFrame()).not.toContain("Assigned coding model")
    expect(setup.captureCharFrame()).not.toContain("80 credits")
    expect(setup.captureCharFrame()).not.toContain("180 credits")
    output = { ...output, status: "idle", errorCode: undefined }
    setup.events.emit({
      id: "evt_signout",
      created: 1,
      type: "credential.switched",
      data: { integrationID: "learnsmart", credentialID: null },
    })
    await setup.waitForFrame((frame) => frame.includes("Sign in with /connect"))
    expect(requests).toBe(accountType === "individual" ? 7 : 4)
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => frame.includes("commands"))
  },
)
