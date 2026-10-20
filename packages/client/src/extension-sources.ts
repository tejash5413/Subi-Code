import type { ConfigEntry } from "./promise/generated/types.js"

/** Only global sources are editable by the global configuration endpoint. */
export function globalExtensionSources(entries: ConfigEntry[]) {
  const boundary = entries.findIndex((entry) => entry.type === "directory")
  const globals = boundary === -1 ? entries : entries.slice(0, boundary)
  const plugins = new Map<string, Record<string, unknown>>()
  const skills = new Set<string>()
  for (const entry of globals) {
    if (entry.type !== "document") continue
    for (const plugin of entry.info.plugins ?? []) {
      plugins.set(
        typeof plugin === "string" ? plugin : plugin.package,
        typeof plugin === "string" ? {} : (plugin.options ?? {}),
      )
    }
    for (const skill of entry.info.skills ?? []) skills.add(skill)
  }
  return { plugins, skills: [...skills] }
}
