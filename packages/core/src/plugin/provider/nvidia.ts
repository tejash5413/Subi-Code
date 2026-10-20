import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Product } from "@opencode/util/product"

export const NvidiaPlugin = define({
  id: "opencode.provider.nvidia",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.provider.transform((evt) => {
      for (const item of evt.list()) {
        if (item.provider.package !== "@opencode/ai/providers/openai-compatible") continue
        if (item.provider.settings?.baseURL !== "https://integrate.api.nvidia.com/v1") continue
        evt.update(item.provider.id, (provider) => {
          provider.headers = {
            ...provider.headers,
            "HTTP-Referer": Product.website,
            "X-Title": Product.name,
            "X-BILLING-INVOKE-ORIGIN": provider.headers?.["X-BILLING-INVOKE-ORIGIN"] ?? Product.name,
          }
        })
      }
    })
  }),
})
