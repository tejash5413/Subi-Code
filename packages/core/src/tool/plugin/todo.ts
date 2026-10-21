export * as TodoTool from "./todo.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { SessionTodo } from "@opencode/schema/session-todo"
import { Effect, Schema } from "effect"

export const Input = Schema.Struct({ todos: SessionTodo.List })
export const Plugin = {
  id: "subi.tool.todo",
  effect: Effect.fn("TodoTool.Plugin")(function* (ctx: Context) {
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "todowrite",
          options: { codemode: false },
          description:
            "Track a checklist for multi-step work in this session. Create it when planning complex work and update task statuses as work progresses. Send the complete current list each time; an empty list clears it. This only records task progress and does not execute tasks. Simple questions do not need a checklist.",
          input: Input,
          output: Input,
          execute: (input) =>
            Effect.succeed({
              output: input,
              content: `${input.todos.filter((todo) => todo.status === "completed").length}/${input.todos.length} tasks completed`,
              metadata: {
                todos: input.todos.map((todo) => ({
                  content: todo.content,
                  status: todo.status,
                  ...(todo.id === undefined ? {} : { id: todo.id }),
                  ...(todo.priority === undefined ? {} : { priority: todo.priority }),
                })),
              },
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
