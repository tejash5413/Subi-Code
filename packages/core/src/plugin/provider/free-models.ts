import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"

const restrictedAccess = Schema.Struct({ error: Schema.Struct({ type: Schema.Literal("FreeTierError") }) })

/** Preserve the provider's denial without advertising an upgrade or confusing it with quota. */
export const FreeModelsPlugin = define({
  id: "subi.provider.free-models",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.session.hook(
      "http.response",
      (event) =>
        Effect.gen(function* () {
          const restricted =
            event.response.status === 403 &&
            (yield* Effect.tryPromise(() => event.response.clone().json()).pipe(
              Effect.map(Schema.is(restrictedAccess)),
              Effect.orElseSucceed(() => false),
            ))
          if (!restricted && event.response.status !== 402 && event.response.status !== 429) return
          yield* Effect.promise(() => event.response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)
          const headers = new Headers(event.response.headers)
          headers.delete("Content-Length")
          headers.delete("Content-Encoding")
          headers.delete("Transfer-Encoding")
          headers.set("Content-Type", "application/json")
          event.response = new Response(
            JSON.stringify({
              error: {
                message: restricted
                  ? "OpenCode's hosted free models are unavailable to Subi Code. Select a connected provider."
                  : "Free model limit reached. Wait for the limit to reset or select another available model.",
                code: restricted ? "free_model_access_restricted" : "free_model_limit",
              },
            }),
            { status: event.response.status, headers },
          )
        }),
      { providerID: "opencode" },
    )
  }),
})
