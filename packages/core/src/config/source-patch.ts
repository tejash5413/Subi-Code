import { applyEdits, findNodeAtLocation, modify, parseTree, type Node } from "jsonc-parser"
import type { Patch } from "@opencode/schema/config"

type Kind = "plugins" | "skills"
type Key = string | number

function roots(tree: Node, kind: Kind) {
  if (kind === "plugins") return [["plugin"], ["plugins"]]
  return findNodeAtLocation(tree, ["skills"])?.type === "object"
    ? [
        ["skills", "paths"],
        ["skills", "urls"],
      ]
    : [["skills"]]
}

function name(node: Node, kind: Kind) {
  const value: unknown =
    kind === "skills" || node.type === "string"
      ? node.value
      : node.type === "array"
        ? node.children?.[0]?.value
        : findNodeAtLocation(node, ["package"])?.value
  return typeof value === "string" ? value : undefined
}

function matches(tree: Node, kind: Kind, target: string) {
  return roots(tree, kind).flatMap((root) =>
    (findNodeAtLocation(tree, root)?.children ?? []).flatMap((node, index) =>
      name(node, kind) === target ? [[...root, index]] : [],
    ),
  )
}

export function ownsSource(text: string, kind: Kind, target: string) {
  const tree = parseTree(text)
  return tree ? matches(tree, kind, target).length > 0 : false
}

/** Edit individual array entries so comments and unrelated settings survive. */
export function patchSources(text: string, patch: Pick<Patch, "plugins" | "skills">) {
  let result = text
  const write = (keys: Key[], value: unknown) => {
    result = applyEdits(result, modify(result, keys, value, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
  }
  const tree = () => {
    const value = parseTree(result)
    if (!value || value.type !== "object") throw new Error("Configuration must be a JSON object")
    return value
  }
  for (const [target, options] of Object.entries(patch.plugins ?? {})) {
    const locations = matches(tree(), "plugins", target)
    const selected = locations.at(-1)
    for (const keys of locations.toReversed()) {
      write(
        keys,
        options === null || keys !== selected
          ? undefined
          : keys[0] === "plugin"
            ? [target, options]
            : { package: target, options },
      )
    }
    if (!selected && options !== null) write(["plugins", -1], { package: target, options })
  }
  for (const [target, enabled] of Object.entries(patch.skills ?? {})) {
    const current = tree()
    const locations = matches(current, "skills", target)
    if (!enabled) {
      for (const keys of locations.toReversed()) write(keys, undefined)
      continue
    }
    if (locations.length) continue
    const keys =
      findNodeAtLocation(current, ["skills"])?.type === "object"
        ? ["skills", /^https?:\/\//i.test(target) ? "urls" : "paths", -1]
        : ["skills", -1]
    write(keys, target)
  }
  return result
}
