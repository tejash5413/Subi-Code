import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLMClient, Message } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { Agent } from "@opencode/core/agent"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { LearnSmartNativeGateway, registerLearnSmartNative } from "@opencode/core/plugin/learnsmart-native"
import { make } from "@opencode/core/plugin/provider/learnsmart"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { WebSocketConstructor } from "@opencode/core/effect/websocket-constructor"
import { LearnSmartManagedService } from "@subi/managed/services/managed/learnsmartManagedService"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(
  Layer.mergeAll(
    LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer)),
    SessionModelRequest.layer.pipe(
      Layer.provide(SessionModelTransport.layer.pipe(Layer.provide(WebSocketConstructor.layer))),
    ),
  ).pipe(Layer.provideMerge(PluginTestLayer)),
)

it.live(
  "native catalog, owned request transport, replay identity and fresh account permission gates use real local HTTP",
  () =>
    Effect.gen(function* () {
      const state = { allowed: true, enabled: true, profile: "full", expired: false }
      const requests: unknown[] = []
      const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          expect(request.headers.get("authorization")).toBe("Bearer native-token-sentinel")
          const path = new URL(request.url).pathname
          if (path === "/managed/access-status")
            return Response.json({
              allowed: state.allowed,
              accountType: "school",
              quotaMode: "school_tokens",
              permissionPolicy: {
                schemaVersion: 1,
                profileCeiling: state.profile,
                source: "school_role",
                validUntilMs: Date.now() + (state.expired ? -1 : 60_000),
              },
            })
          if (path === "/managed/models")
            return Response.json({
              allowed: true,
              source: "school",
              quotaMode: "school_tokens",
              models: [
                {
                  modelKey: "mdl_native",
                  displayName: "Assigned native coding model",
                  contextLength: 131072,
                  capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
                },
              ],
            })
          if (path === "/agent/native/status")
            return state.enabled
              ? Response.json({ protocolVersion: 1, textOnly: true })
              : new Response(null, { status: 503 })
          if (path === "/agent/turn") {
            requests.push(await request.json())
            return new Response(
              'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "Content-Type": "text/event-stream" } },
            )
          }
          return new Response(null, { status: 404 })
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
      const credentials = yield* Credential.Service
      const saved = yield* credentials.create({
        integrationID: Integration.ID.make("learnsmart"),
        value: {
          type: "oauth",
          methodID: Integration.MethodID.make("learnsmart-browser"),
          access: "native-token-sentinel",
          refresh: "refresh-sentinel",
          expires: Date.now() + 3600000,
          metadata: { uid: "native-user", role: "student", accountType: "school" },
        },
      })
      const plugins = yield* Plugin.Service
      const ctx = yield* PluginHost.make(plugins)
      yield* make(undefined, new LearnSmartManagedService(server.url.toString())).effect(ctx)
      const native = yield* registerLearnSmartNative(
        ctx,
        new LearnSmartManagedService(server.url.toString()),
        new LearnSmartNativeGateway(server.url.toString().replace(/\/$/, "")),
      )
      yield* native.refresh()
      const models = yield* Model.Service
      expect((yield* models.available()).find((model) => model.providerID === "learnsmart")).toMatchObject({
        id: "mdl_native",
        name: "Assigned native coding model",
        limit: { context: 131072 },
        capabilities: { input: ["text"] },
      })
      const hooks = yield* PluginHooks.Service
      const scope = {
        sessionID: Session.ID.make("ses_native"),
        agent: Agent.ID.make("build"),
        kind: "primary" as const,
        model: { providerID: Provider.ID.make("learnsmart"), id: Model.ID.make("mdl_native") },
      }
      const shaped = yield* hooks.trigger("session", "model.request", { ...scope, headers: {} })
      const send = () =>
        hooks.trigger("session", "http.request", {
          ...scope,
          request: new Request("https://untrusted.example/chat/completions", {
            method: "POST",
            headers: { ...shaped.headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "must-not-forward-upstream-id",
              messages: [{ role: "user", content: "Fix the project" }],
              stream: true,
            }),
          }),
        })
      const first = yield* send()
      const second = yield* send()
      expect(first.request.url).toBe(`${server.url.toString().replace(/\/$/, "")}/agent/turn`)
      expect(first.request.headers.get("x-subi-connection")).toBeNull()
      const firstBody = yield* Effect.promise(() => first.request.clone().json())
      const secondBody = yield* Effect.promise(() => second.request.clone().json())
      expect(firstBody).toEqual(secondBody)
      expect(firstBody).toMatchObject({
        protocolVersion: 1,
        modelKey: "mdl_native",
        agentMode: "build",
        providerRequestIndex: 0,
        toolCapabilityVersion: "agent_v3",
      })
      expect(JSON.stringify(firstBody)).not.toMatch(/native-token-sentinel|refresh-sentinel|must-not-forward/)
      expect(yield* Effect.promise(() => fetch(first.request).then((r) => r.text()))).toContain("OK")
      expect(requests).toHaveLength(1)
      const session = yield* ctx.session.create({ model: scope.model, agent: scope.agent })
      const catalog = yield* models.get(scope.model.providerID, scope.model.id)
      expect(catalog).toBeDefined()
      const runtime = yield* ModelResolver.fromCatalogModel(catalog!, saved.value)
      const resolved = {
        model: runtime,
        ref: scope.model,
        capabilities: catalog!.capabilities,
        cost: catalog!.cost,
        limit: catalog!.limit,
      }
      const builder = yield* SessionModelRequest.Service
      const prepared = yield* builder.primary({
        session,
        agent: scope.agent,
        model: resolved!,
        system: [],
        messages: [Message.user("Reply OK through the native coding request path.")],
      })
      const llm = yield* LLMClient.Service
      const completion = yield* llm.stream(prepared.request, prepared.options).pipe(Stream.runCollect)
      expect(Array.from(completion).some((event) => event.type === "text-delta")).toBe(true)
      expect(requests).toHaveLength(2)
      const permission = () =>
        hooks.trigger("permission", "evaluate", {
          sessionID: scope.sessionID,
          action: "edit",
          resources: ["src/auth.ts"],
          effect: "allow",
        })
      expect((yield* permission()).effect).toBe("allow")
      state.profile = "ask"
      expect((yield* permission()).effect).toBe("ask")
      state.expired = true
      expect((yield* permission()).effect).toBe("deny")
      state.expired = false
      state.allowed = false
      expect((yield* permission()).effect).toBe("deny")
      state.allowed = true
      state.enabled = false
      yield* native.refresh()
      expect((yield* models.available()).filter((model) => model.providerID === "learnsmart")).toEqual([])
      const integrations = yield* Integration.Service
      yield* integrations.connection.remove(saved.id)
      expect((yield* permission()).effect).toBe("deny")
      const failed = yield* send().pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
    }),
)
