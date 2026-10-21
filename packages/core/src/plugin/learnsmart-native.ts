import { createHash } from "node:crypto"
import { Clock, Effect, Schedule, Schema, Semaphore, Stream } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ProviderRecord } from "@opencode/plugin/effect/provider"
import type { Session } from "@opencode/schema/session"
import { LearnSmartManagedService } from "@subi/managed/services/managed/learnsmartManagedService"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"
import { IntegrationConnection } from "../integration/connection.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Provider } from "../provider.js"

export const nativeOrigin = "https://asia-south1-learnsmart-c2a7e.cloudfunctions.net/subiManagedAgentApi"
const integrationID = Integration.ID.make("learnsmart")
const readActions = new Set(["read", "glob", "grep", "list", "lsp", "skill", "webfetch", "websearch"])
const readTools = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "list",
  "webfetch",
  "websearch",
  "question",
  "skill",
  "todowrite",
])
const nativeBody = Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  tool_choice: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Int),
  max_completion_tokens: Schema.optional(Schema.Int),
})

/** The origin is application-owned; user provider settings cannot redirect ID tokens. */
export class LearnSmartNativeGateway {
  constructor(readonly origin = nativeOrigin) {}

  async available(token: string, signal: AbortSignal) {
    const response = await fetch(`${this.origin}/agent/native/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      redirect: "error",
    })
    if (!response.ok) return false
    const value: unknown = await response.json()
    return Schema.is(Schema.Struct({ protocolVersion: Schema.Literal(1), textOnly: Schema.Literal(true) }))(value)
  }
}

export const registerLearnSmartNative = Effect.fn(function* (
  ctx: Context,
  managed: LearnSmartManagedService,
  gateway: LearnSmartNativeGateway,
) {
  const bus = yield* Bus.Service
  const agents = yield* Agent.Service
  const owners = new Map<Session.ID, string>()
  const loaded: {
    models: Model.Info[]
    connection?: ProviderRecord["sourceConnection"]
    ready: boolean
  } = {
    models: [],
    ready: false,
  }
  const resolve = Effect.fn(function* () {
    const connection = yield* ctx.integration.connection.active(integrationID)
    if (!connection || connection.type !== "credential") return
    const value = yield* ctx.integration.connection.resolve(connection)
    if (value?.type !== "oauth" || value.methodID !== "learnsmart-browser") return
    return { connection, value, key: `credential:${connection.id}` }
  })
  const freeModels = new Set<string>()
  const loading = yield* Semaphore.make(1)
  const load = Effect.fn(function* () {
    const selected = yield* resolve()
    if (IntegrationConnection.key(loaded.connection) !== selected?.key || !selected) {
      loaded.ready = false
      loaded.models = []
      freeModels.clear()
      loaded.connection = undefined
      yield* ctx.provider.reload()
    }
    if (!selected) return
    const models = yield* Effect.tryPromise(async (signal) => {
      const access = await managed.getAccessStatus(selected.value.access, signal)
      if (!access.allowed || !(await gateway.available(selected.value.access, signal))) return []
      return (await managed.getModels(selected.value.access, signal)).models
    }).pipe(Effect.orElseSucceed(() => []))
    const current = yield* resolve()
    if (current?.key !== selected.key) return
    freeModels.clear()
    for (const model of models) if (model.freeCoding === true) freeModels.add(model.modelKey)
    loaded.connection = selected.connection
    loaded.models = models
      .filter((model) => model.capabilities.toolCalling && model.contextLength && model.contextLength > 0)
      .map((model) => ({
        ...Model.Info.default(Provider.ID.make("learnsmart"), Model.ID.make(model.modelKey)),
        name: model.displayName,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: {
          context: model.contextLength!,
          output: Math.min(32_000, Math.max(1, Math.floor(model.contextLength! / 4))),
        },
      }))
    loaded.ready = loaded.models.length > 0
    yield* ctx.provider.reload()
  })
  const refresh = () => loading.withPermit(load())
  yield* ctx.provider.transform((editor) => {
    if (!loaded.ready || !loaded.connection) return
    editor.add({
      info: {
        id: Provider.ID.make("learnsmart"),
        integrationID,
        name: "LearnSmart",
        activation: "auto",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${gateway.origin}/agent`, provider: "learnsmart", compaction: { type: "summary" } },
      },
      models: loaded.models,
      sourceConnection: loaded.connection,
    })
  })
  yield* ctx.session.hook(
    "context",
    (event) =>
      Effect.sync(() => {
        if (event.agent !== "plan" && event.agent !== "ask") return
        for (const name of Object.keys(event.tools)) if (!readTools.has(name)) delete event.tools[name]
      }).pipe(Effect.orDie),
    { providerID: "learnsmart" },
  )
  for (const hook of ["generate", "compaction"] as const)
    yield* ctx.session.hook(
      hook,
      (event) =>
        Effect.sync(() => {
          for (const name of Object.keys(event.tools)) delete event.tools[name]
        }),
      { providerID: "learnsmart" },
    )
  yield* ctx.session.hook(
    "model.request",
    (event) =>
      Effect.gen(function* () {
        const selected = yield* resolve()
        if (!selected || !loaded.ready || IntegrationConnection.key(loaded.connection) !== selected.key)
          return yield* Effect.die(new Error("Refresh your LearnSmart account before using this model."))
        event.headers["x-subi-connection"] = selected.key
        if (event.kind !== "primary") return
        if (owners.size >= 1024 && !owners.has(event.sessionID))
          return yield* Effect.die(
            new Error("LearnSmart session capacity reached. Close unused sessions before continuing."),
          )
        owners.set(event.sessionID, selected.key)
      }).pipe(Effect.orDie),
    { providerID: "learnsmart" },
  )
  yield* ctx.session.hook(
    "http.request",
    (event) =>
      Effect.gen(function* () {
        const selected = yield* resolve()
        if (!selected || event.request.headers.get("x-subi-connection") !== selected.key)
          return yield* Effect.die(new Error("LearnSmart account changed. Start a fresh request."))
        const input = yield* Effect.tryPromise(() => event.request.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(nativeBody)),
          Effect.orDie,
        )
        const { max_completion_tokens, ...nativeRequest } = input
        if (max_completion_tokens !== undefined) nativeRequest.max_tokens = max_completion_tokens
        const body = {
          protocolVersion: 1,
          modelKey: event.model.id,
          ...(freeModels.has(event.model.id) ? {freeModelOnly:true} : {}),
          agentMode:
            event.kind !== "primary" || event.agent === "ask" ? "ask" : event.agent === "plan" ? "plan" : "build",
          clientRunId: `nat_${createHash("sha256")
            .update(`${event.sessionID}\n${event.kind}\n${JSON.stringify(input)}`)
            .digest("hex")
            .slice(0, 56)}`,
          providerRequestIndex: 0,
          toolCapabilityVersion:
            event.kind !== "primary" || event.agent === "ask" || event.agent === "plan" ? "inspect_v1" : "agent_v3",
          nativeRequest,
        }
        event.request = new Request(`${gateway.origin}/agent/turn`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${selected.value.access}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": event.request.headers.get("user-agent") ?? "subi",
          },
          body: JSON.stringify(body),
          signal: event.request.signal,
        })
      }).pipe(Effect.orDie),
    { providerID: "learnsmart" },
  )
  // Ambiguous/partially settled requests must not be silently dispatched again.
  yield* ctx.session.hook(
    "retry",
    (event) =>
      Effect.sync(() => {
        event.decision = { retry: false }
      }),
    { providerID: "learnsmart" },
  )
  yield* ctx.permission.hook("evaluate", (event) =>
    Effect.gen(function* () {
      const owner = owners.get(event.sessionID)
      if (!owner && !loaded.ready) return
      const session = owner ? undefined : yield* ctx.session.get({ sessionID: event.sessionID })
      if ((!owner && session?.model?.providerID !== "learnsmart") || event.effect === "deny") return
      const selected = yield* resolve().pipe(Effect.orElseSucceed(() => undefined))
      if (!selected || selected.key !== owner) {
        event.effect = "deny"
        event.message = "LearnSmart account changed. Start a fresh request."
        return
      }
      if (readActions.has(event.action)) return
      const access = yield* Effect.tryPromise((signal) => managed.getAccessStatus(selected.value.access, signal)).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const current = yield* resolve().pipe(Effect.orElseSucceed(() => undefined))
      const now = yield* Clock.currentTimeMillis
      const policy = access?.permissionPolicy
      if (
        !access?.allowed ||
        current?.key !== owner ||
        !policy ||
        policy.validUntilMs <= now ||
        policy.validUntilMs > now + 330_000 ||
        policy.source !== (access.accountType === "school" ? "school_role" : "individual")
      ) {
        event.effect = "deny"
        event.message = "LearnSmart tool permissions could not be freshly verified."
        return
      }
      if (policy.profileCeiling === "full") return
      if (policy.profileCeiling === "session" && event.action !== "external_directory") {
        const currentSession = session ?? (yield* ctx.session.get({ sessionID: event.sessionID }))
        const agent = yield* agents.resolve(event.agent ?? currentSession?.agent ?? Agent.ID.make("build"))
        if (
          currentSession &&
          event.resources.every(
            (resource) =>
              Permission.evaluate(event.action, resource, agent?.permissions ?? [], currentSession.permissions ?? [])
                .effect === "allow",
          )
        )
          return
      }
      event.effect = "ask"
      event.message = "Your LearnSmart account requires approval for this action."
    }).pipe(Effect.orDie),
  )
  yield* bus.subscribe(Credential.Event.Switched).pipe(
    Stream.filter((event) => event.data.integrationID === integrationID),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const selected = yield* resolve().pipe(Effect.orElseSucceed(() => undefined))
        yield* Effect.forEach(
          Array.from(owners),
          ([sessionID, owner]) =>
            owner === selected?.key ? Effect.void : ctx.session.interrupt({ sessionID }).pipe(Effect.ignore),
          { concurrency: 4, discard: true },
        )
        yield* refresh().pipe(Effect.ignore)
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* refresh().pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped)
  return { ready: () => loaded.ready, refresh: () => refresh().pipe(Effect.ignore) }
})
