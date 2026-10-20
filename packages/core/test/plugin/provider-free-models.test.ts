import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { FreeModelsPlugin } from "@opencode/core/plugin/provider/free-models"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

;[
  ["opencode", 402],
  ["opencode", 429],
  ["opencode", 200],
  ["openrouter", 429],
].forEach(([provider, status]) => {
  it.live(
    `free-model limit response provider=${provider} status=${status} preserves native status and avoids upsells`,
    () =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const host = yield* PluginHost.make(plugins)
        expect(ProviderPlugins.map((plugin) => plugin.id)).toContain(FreeModelsPlugin.id)
        yield* FreeModelsPlugin.effect(host)
        const hooks = yield* PluginHooks.Service
        const response = Response.json(
          { error: { message: "Upgrade to Go or Zen to continue" } },
          {
            status: Number(status),
            headers: { "Retry-After": "60", "Content-Length": "1234", "Content-Encoding": "gzip" },
          },
        )
        const event = yield* hooks.trigger("session", "http.response", {
          sessionID: Session.ID.make("ses_free"),
          agent: Agent.ID.make("build"),
          kind: "generate",
          model: { providerID: Provider.ID.make(String(provider)), id: Model.ID.make("free") },
          request: new Request("https://provider.example/chat/completions"),
          response,
        })
        expect(event.response.status).toBe(Number(status))
        if (provider === "opencode" && status !== 200) {
          expect(event.response.headers.get("retry-after")).toBe("60")
          expect(event.response.headers.get("content-length")).toBeNull()
          expect(event.response.headers.get("content-encoding")).toBeNull()
          const body = yield* Effect.promise(() => event.response.text())
          expect(body).toContain("Free model limit reached")
          expect(body).not.toMatch(/Go|Zen|upgrade/i)
        } else expect(event.response).toBe(response)
      }),
  )
})
;[
  [
    "opencode",
    {
      type: "FreeTierError",
      message:
        "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
    },
    true,
  ],
  ["opencode", { type: "PermissionDenied", message: "Project access denied" }, false],
  ["openrouter", { type: "FreeTierError", message: "Provider access denied" }, false],
].forEach(([provider, error, restricted]) => {
  it.live(`free-model access rejection provider=${provider} restricted=${restricted} remains an access failure`, () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* FreeModelsPlugin.effect(yield* PluginHost.make(plugins))
      const hooks = yield* PluginHooks.Service
      const response = Response.json({ type: "error", error }, { status: 403 })
      const event = yield* hooks.trigger("session", "http.response", {
        sessionID: Session.ID.make("ses_restricted"),
        agent: Agent.ID.make("build"),
        kind: "generate",
        model: { providerID: Provider.ID.make(String(provider)), id: Model.ID.make("free") },
        request: new Request("https://provider.example/chat/completions"),
        response,
      })
      expect(event.response.status).toBe(403)
      const body = yield* Effect.promise(() => event.response.text())
      if (restricted) {
        expect(body).toContain("unavailable to Subi Code")
        expect(body).toContain("free_model_access_restricted")
        expect(body).not.toMatch(/limit reached|upgrade|Download it|Zen|Go/)
      } else {
        expect(event.response).toBe(response)
        expect(body).toBe(JSON.stringify({ type: "error", error }))
      }
    }),
  )
})
