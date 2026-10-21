import { Effect, Schema, Stream } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { LearnSmartAccount } from "@opencode/schema/learnsmart-account"
import {
  ManagedSessionController,
  toManagedWebviewState,
} from "@subi/managed/services/managed/managedSessionController"
import type { LearnSmartManagedService } from "@subi/managed/services/managed/learnsmartManagedService"
import { idleManagedSession, resolveManagedQuotaMode } from "@subi/managed/services/managed/managedTypes"
import { Bus } from "../bus.js"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"

const integrationID = Integration.ID.make("learnsmart")
const user = Schema.Struct({
  uid: Schema.String,
  email: Schema.String,
  role: Schema.Literals(["student", "teacher"]),
  accountType: Schema.optional(Schema.Literals(["school", "individual"])),
})
const decodeUser = Schema.decodeUnknownOption(user)

export const registerLearnSmartAccount = Effect.fn(function* (
  ctx: Context,
  service: LearnSmartManagedService,
  native?: { ready: () => boolean; refresh: () => Effect.Effect<void> },
) {
  const bus = yield* Bus.Service
  const requests = new Set<ManagedSessionController>()
  const clear = () => {
    requests.forEach((controller) => controller.dispose())
    requests.clear()
  }
  yield* Effect.addFinalizer(() => Effect.sync(clear))
  yield* bus.subscribe(Credential.Event.Switched).pipe(
    Stream.filter((event) => event.data.integrationID === integrationID),
    Stream.runForEach(() => Effect.sync(clear)),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* ctx.rpc
    .register(LearnSmartAccount.Contract, {
      get: () =>
        Effect.gen(function* () {
          const connection = yield* ctx.integration.connection.active(integrationID)
          if (!connection) return snapshot(idleManagedSession())
          const value = yield* ctx.integration.connection
            .resolve(connection)
            .pipe(Effect.orElseSucceed(() => undefined))
          if (value?.type !== "oauth" || value.methodID !== "learnsmart-browser") return snapshot(idleManagedSession())
          const identity = decodeUser(value.metadata)
          if (identity._tag === "None")
            return snapshot({ ...idleManagedSession(), status: "unavailable", errorCode: "managed_auth" })
          const controller = new ManagedSessionController(
            { getCurrentUser: () => identity.value, getIdToken: async () => value.access },
            service,
            { loadSelectedModelKey: () => undefined, saveSelectedModelKey: () => {} },
          )
          requests.add(controller)
          const result = yield* Effect.tryPromise({
            try: async (signal) => {
              const cancel = () => controller.dispose()
              signal.addEventListener("abort", cancel, { once: true })
              try {
                if (signal.aborted) cancel()
                else await controller.bootstrap()
                return snapshot(controller.getState())
              } finally {
                signal.removeEventListener("abort", cancel)
                requests.delete(controller)
                controller.dispose()
              }
            },
            catch: () => new Error("Unable to refresh the LearnSmart account."),
          }).pipe(
            Effect.orElseSucceed(() =>
              snapshot({ ...idleManagedSession(), status: "unavailable", errorCode: "managed_network" }),
            ),
          )
          if (native) yield* native.refresh()
          const current = yield* ctx.integration.connection.active(integrationID)
          if (
            !current ||
            current.type !== connection.type ||
            (current.type === "credential" && connection.type === "credential" && current.id !== connection.id)
          )
            return snapshot(idleManagedSession())
          return { ...result, inferenceAvailable: native?.ready() ?? false }
        }),
    })
    .pipe(Effect.orDie)
})

function snapshot(state: ReturnType<ManagedSessionController["getState"]>): LearnSmartAccount.Snapshot {
  const projected = toManagedWebviewState(state)
  const quotaMode = resolveManagedQuotaMode(state)
  return {
    status: state.status,
    ...(state.user?.accountType ? { accountType: state.user.accountType } : {}),
    ...(quotaMode ? { quotaMode } : {}),
    models: projected.models.map((model) => ({
      modelKey: model.modelKey,
      displayName: model.displayName,
      ...(model.freeCoding === true ? {freeCoding:true} : {}),
      ...(model.contextLength === undefined || model.contextLength === null
        ? {}
        : { contextLength: model.contextLength }),
    })),
    monthlyLimit: {
      configured: state.monthlyLimit.configured,
      monthlyTokenLimit: state.monthlyLimit.monthlyTokenLimit,
    },
    usage: {
      status: state.usage.status,
      ...(state.usage.usage?.usedTokens === undefined ? {} : { usedTokens: state.usage.usage.usedTokens }),
      ...(state.usage.usage?.remainingTokens === undefined
        ? {}
        : { remainingTokens: state.usage.usage.remainingTokens }),
      ...(state.usage.errorCode ? { errorCode: state.usage.errorCode } : {}),
    },
    ...(projected.creditSummary ? { credits: projected.creditSummary } : {}),
    ...(projected.subscription
      ? { subscription: { active: projected.subscription.active, renewalDateMs: projected.subscription.renewalDateMs } }
      : {}),
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    inferenceAvailable: false,
  }
}
