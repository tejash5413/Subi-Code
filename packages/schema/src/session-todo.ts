export * as SessionTodo from "./session-todo.js"

import { Schema } from "effect"

export const Info = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
  priority: Schema.optional(Schema.Literals(["low", "medium", "high"])),
})
export type Info = typeof Info.Type
export const List = Schema.Array(Info).check(Schema.isMaxLength(100))
