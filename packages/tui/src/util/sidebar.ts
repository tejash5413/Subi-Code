import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { SessionTodo } from "@opencode/schema/session-todo"
import { Option, Schema } from "effect"

const decodeTodos = Schema.decodeUnknownOption(SessionTodo.List)

/** Prefer the durable task tool; current-turn Markdown checklists support older sessions. */
export function sidebarTodos(messages: readonly SessionMessageInfo[]) {
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue
    for (const part of message.content.toReversed()) {
      if (part.type !== "tool" || part.name !== "todowrite" || part.state.status !== "completed") continue
      const value = decodeTodos(part.state.metadata?.todos ?? part.state.input.todos)
      if (Option.isSome(value))
        return value.value.map((todo) => ({
          text: todo.content,
          done: todo.status === "completed",
          status: todo.status,
        }))
    }
  }
  for (const message of messages.toReversed()) {
    if (message.type === "user") break
    if (message.type !== "assistant") continue
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    let fence: string | undefined
    const todos: { text: string; done: boolean; status: SessionTodo.Info["status"] }[] = []
    for (const line of text.split("\n")) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)
      if (marker) {
        if (!fence) fence = marker[1][0]
        else if (marker[1][0] === fence) fence = undefined
        continue
      }
      if (fence) continue
      const item = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/)
      if (item)
        todos.push({
          text: item[2],
          done: item[1].toLowerCase() === "x",
          status: item[1].toLowerCase() === "x" ? "completed" : "pending",
        })
    }
    if (todos.length) return todos
  }
  return []
}

/** Counts describe successful recorded edits, not an inferred git working-tree diff. */
export function sidebarChanges(messages: readonly SessionMessageInfo[]) {
  const files = new Map<
    string,
    { path: string; status: "added" | "modified" | "deleted"; additions?: number; deletions?: number }
  >()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const edits = part.state.metadata?.files
      if (!Array.isArray(edits)) {
        // Older successful writes have an authoritative success label but no diff metadata.
        if (part.name !== "write" || typeof part.state.input.path !== "string") continue
        const output = part.state.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n")
        const created = output.startsWith("Created file successfully:")
        if (!created && !output.startsWith("Wrote file successfully:")) continue
        const path = output
          .split("\n", 1)[0]
          .replace(/^(?:Created|Wrote) file successfully:\s*/, "")
          .trim()
        if (!path) continue
        const previous = files.get(path)
        files.set(path, { path, status: created || previous?.status === "added" ? "added" : "modified" })
        continue
      }
      for (const edit of edits) {
        if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue
        const path = edit.file ?? edit.relativePath ?? edit.filePath
        if (typeof path !== "string" || !path) continue
        if (typeof edit.additions !== "number" || !Number.isFinite(edit.additions) || edit.additions < 0) continue
        if (typeof edit.deletions !== "number" || !Number.isFinite(edit.deletions) || edit.deletions < 0) continue
        const previous = files.get(path)
        const status =
          edit.status === "added" || edit.type === "add"
            ? "added"
            : edit.status === "deleted" || edit.type === "delete"
              ? "deleted"
              : "modified"
        files.set(path, {
          path,
          status: status === "modified" && previous?.status === "added" ? "added" : status,
          ...(previous && (previous.additions === undefined || previous.deletions === undefined)
            ? {}
            : {
                additions: (previous?.additions ?? 0) + edit.additions,
                deletions: (previous?.deletions ?? 0) + edit.deletions,
              }),
        })
      }
    }
  }
  return [...files.values()]
}

export function sidebarStatus(
  messages: readonly SessionMessageInfo[],
  running: boolean,
  outcome?: SessionInfo["outcome"],
) {
  if (running) return "Running"
  const last = messages.findLast((message) => message.type === "idle" || message.type === "user")
  const recorded = last?.type === "idle" ? last.outcome : messages.length === 0 ? outcome : undefined
  if (!recorded) return "Idle"
  return { succeeded: "Completed", failed: "Failed", interrupted: "Stopped" }[recorded]
}

/** Public text and tool labels only; reasoning and tool arguments stay in the transcript. */
export function sidebarActivity(messages: readonly SessionMessageInfo[]) {
  return messages
    .flatMap((message) => {
      if (message.type !== "assistant") return []
      return message.content.flatMap((part) => {
        if (part.type === "text" && part.text.trim()) return [part.text]
        if (part.type === "tool") return [`${part.name} · ${part.state.status}`]
        return []
      })
    })
    .slice(-8)
}
