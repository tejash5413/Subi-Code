import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { TodoTool } from "@opencode/core/tool/plugin/todo"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Tool.node])))
it.effect("todo tool validates and records the complete checklist as durable tool metadata", () =>
  Effect.gen(function* () {
    yield* registerToolPlugin(TodoTool.Plugin)
    const registry = yield* Tool.Service
    expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("todowrite")
    const todos = [{ id: "ui", content: "Fix CLI previews", status: "in_progress", priority: "high" }]
    const call = (input: unknown, id: string) => ({
      ...toolIdentity,
      sessionID: Session.ID.make("ses_todo_test"),
      call: { type: "tool-call" as const, id, name: "todowrite", input },
    })
    expect(yield* executeTool(registry, call({ todos }, "set"))).toMatchObject({
      status: "completed",
      output: { todos },
      metadata: { todos },
    })
    expect(yield* executeTool(registry, call({ todos: [] }, "clear"))).toMatchObject({
      status: "completed",
      metadata: { todos: [] },
    })
    expect(
      yield* executeTool(registry, call({ todos: [{ content: "Invalid", status: "made_up" }] }, "invalid")),
    ).toMatchObject({ status: "error" })
  }),
)
