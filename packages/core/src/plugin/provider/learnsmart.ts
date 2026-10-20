import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { NativeLearnSmartAuth } from "@subi/managed/services/auth/native-auth"
import { LearnSmartManagedService } from "@subi/managed/services/managed/learnsmartManagedService"
import { authorizeLearnSmart, learnSmartMethodID, refreshLearnSmart } from "../../oauth/learnsmart.js"
import { registerLearnSmartAccount } from "../learnsmart-account.js"
import { LearnSmartNativeGateway, registerLearnSmartNative } from "../learnsmart-native.js"

export function make(
  auth = new NativeLearnSmartAuth(),
  managed = new LearnSmartManagedService(),
  gateway?: LearnSmartNativeGateway,
) {
  return define({
    id: "subi.account.learnsmart",
    effect: Effect.fn(function* (ctx) {
      yield* ctx.integration.transform((editor) => {
        editor.update("learnsmart", (integration) => {
          integration.name = "LearnSmart"
        })
        editor.method.update({
          integrationID: "learnsmart",
          method: { id: learnSmartMethodID, type: "oauth", label: "LearnSmart account" },
          authorize: () => authorizeLearnSmart(auth),
          refresh: (value) => refreshLearnSmart(auth, value),
          label: (value) => (typeof value.metadata?.email === "string" ? value.metadata.email : undefined),
        })
      })
      const native = gateway ? yield* registerLearnSmartNative(ctx, managed, gateway) : undefined
      yield* registerLearnSmartAccount(ctx, managed, native)
    }),
  })
}

export const LearnSmartPlugin = make(undefined, undefined, new LearnSmartNativeGateway())
