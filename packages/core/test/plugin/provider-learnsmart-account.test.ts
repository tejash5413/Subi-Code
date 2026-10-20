import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LearnSmartManagedService } from "@subi/managed/services/managed/learnsmartManagedService"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { make } from "@opencode/core/plugin/provider/learnsmart"
import { NativeLearnSmartAuth } from "@subi/managed/services/auth/native-auth"
import { Rpc } from "@opencode/core/rpc"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("learnsmart")

function backend(accountType: "school" | "individual") {
  const calls: string[] = []
  const quotaMode = accountType === "school" ? "school_tokens" : "individual_credits"
  const credits = {
    monthlyGrantMilli: 100_000,
    monthlyRemainingMilli: 60_000,
    topupRemainingMilli: 15_000,
    totalAvailableMilli: 75_000,
  }
  const state = { denied: false, corrupt: false, paused: false }
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const name = new URL(request.url).pathname
      calls.push(name)
      expect(request.headers.get("authorization")).toBe("Bearer account-token-sentinel")
      if (name === "/managed/access-status") {
        started.resolve()
        if (state.paused) await released.promise
        return Response.json({
          allowed: !state.denied,
          accountType,
          quotaMode,
          ...(state.denied ? { code: "SUBI_ACCESS_DISABLED" } : {}),
        })
      }
      if (name === "/managed/models")
        return Response.json({
          allowed: true,
          source: accountType,
          quotaMode,
          models: [
            {
              modelKey: "assigned-1",
              displayName: "Assigned coding model",
              contextLength: 131_072,
              capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
              ...(state.corrupt ? { upstreamModelId: "must-not-leak" } : {}),
            },
          ],
        })
      if (name === "/managed/monthly-limit")
        return Response.json({
          configured: true,
          period: "calendar_month",
          monthlyTokenLimit: accountType === "school" ? 100_000 : null,
          source: accountType,
          quotaMode,
          ...(accountType === "individual" ? { credits } : {}),
        })
      if (name === "/managed/subicode-status")
        return Response.json({
          active: true,
          tier: null,
          renewalDateMs: 1_800_000_000_000,
          source: accountType === "school" ? "school_default" : "individual_subscription",
          quotaMode,
        })
      if (name === "/managed/usage")
        return Response.json({
          allowed: true,
          chatAvailable: true,
          usage:
            accountType === "school"
              ? {
                  quotaMode,
                  configured: true,
                  period: "2026-10",
                  monthlyTokenLimit: 100_000,
                  usedTokens: 1200,
                  remainingTokens: 98_800,
                }
              : { quotaMode, credits },
        })
      return new Response(null, { status: 404 })
    },
  })
  return {
    calls,
    state,
    service: new LearnSmartManagedService(server.url.toString()),
    started: started.promise,
    release: () => released.resolve(),
    [Symbol.asyncDispose]: () => {
      released.resolve()
      return server.stop(true)
    },
  }
}

;[false, true].forEach((switchAccount) => {
  it.live(`discard an in-flight account response after ${switchAccount ? "account switch" : "logout"}`, () =>
    Effect.gen(function* () {
      const local = backend("individual")
      local.state.paused = true
      yield* Effect.addFinalizer(() => Effect.promise(() => local[Symbol.asyncDispose]()))
      const saved = yield* setup(local.service)
      const rpc = yield* Rpc.Service
      const pending = yield* rpc
        .call("subi.learnsmart.account", "get", {})
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => local.started)
      if (switchAccount) {
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID,
          value: {
            ...saved.value,
            ...(saved.value.type === "oauth"
              ? {
                  metadata: {
                    uid: "other-account",
                    email: "other@example.com",
                    role: "teacher",
                    accountType: "school",
                  },
                }
              : {}),
          },
        })
      } else {
        const integrations = yield* Integration.Service
        yield* integrations.connection.remove(saved.id)
      }
      local.release()
      expect(yield* Fiber.join(pending)).toMatchObject({ status: "idle", models: [] })
      expect(local.calls).toEqual(["/managed/access-status"])
    }),
  )
})

const setup = Effect.fn(function* (service: LearnSmartManagedService) {
  const credentials = yield* Credential.Service
  const credential = yield* credentials.create({
    integrationID,
    value: {
      type: "oauth",
      methodID: Integration.MethodID.make("learnsmart-browser"),
      access: "account-token-sentinel",
      refresh: "refresh-sentinel",
      expires: Date.now() + 3_600_000,
      metadata: { uid: "account-1", email: "person@example.com", role: "student", accountType: "individual" },
    },
  })
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "subi.account.learnsmart")
  yield* make(new NativeLearnSmartAuth(), service).effect(host)
  return credential
})

for (const accountType of ["school", "individual"] as const) {
  it.live(
    `loads ${accountType} assigned models, authoritative quota and renewal through the native account boundary`,
    () =>
      Effect.gen(function* () {
        const local = backend(accountType)
        yield* Effect.addFinalizer(() => Effect.promise(() => local[Symbol.asyncDispose]()))
        const saved = yield* setup(local.service)
        const rpc = yield* Rpc.Service
        const read = () => rpc.call("subi.learnsmart.account", "get", {})
        const snapshot = yield* read()
        expect(snapshot).toMatchObject({
          status: "allowed",
          accountType,
          models: [{ displayName: "Assigned coding model", contextLength: 131_072 }],
          subscription: { active: true, renewalDateMs: 1_800_000_000_000 },
          inferenceAvailable: false,
        })
        expect(snapshot).toMatchObject(
          accountType === "school"
            ? { quotaMode: "school_tokens", usage: { usedTokens: 1200, remainingTokens: 98_800 } }
            : {
                quotaMode: "individual_credits",
                credits: { totalAvailableMilli: 75_000, purchasedRemainingMilli: 15_000 },
              },
        )
        expect(local.calls[0]).toBe("/managed/access-status")
        expect(local.calls).toHaveLength(5)
        expect(JSON.stringify(snapshot)).not.toMatch(
          /account-token-sentinel|refresh-sentinel|upstreamModelId|permissionPolicy/,
        )

        local.calls.length = 0
        local.state.denied = true
        expect(yield* read()).toMatchObject({ status: "blocked", models: [], errorCode: "SUBI_ACCESS_DISABLED" })
        expect(local.calls).toEqual(["/managed/access-status", "/managed/subicode-status"])
        local.state.denied = false
        local.state.corrupt = true
        expect(yield* read()).toMatchObject({
          status: "unavailable",
          models: [],
          errorCode: "managed_invalid_response",
        })
        local.calls.length = 0
        const integrations = yield* Integration.Service
        yield* integrations.connection.remove(saved.id)
        expect(yield* read()).toMatchObject({ status: "idle", models: [] })
        expect(local.calls).toEqual([])
      }),
  )
}
