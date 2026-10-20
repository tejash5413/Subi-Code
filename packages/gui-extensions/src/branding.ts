import { brandMessages } from "@opencode/util/product"
import type { Catalog, Messages } from "./sdk/core"
import { Predicate } from "effect"

/** Adapt only the catalogs of our shipping features; external extensions keep their own identity. */
export function brandCatalog<const English extends Messages>(
  catalog: Catalog & { readonly en: English },
): Catalog & { readonly en: { [K in keyof English]: string } } {
  const localized: Record<string, Catalog[string]> = {}

  for (const [locale, source] of Object.entries(catalog)) {
    localized[locale] = Predicate.isFunction(source)
      ? async () => ({ default: brandMessages((await source()).default) })
      : brandMessages(source)
  }

  return { ...localized, en: brandMessages(catalog.en) }
}
