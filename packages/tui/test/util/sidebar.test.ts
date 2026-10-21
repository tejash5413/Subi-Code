import { expect, test } from "bun:test"
import type { SessionMessageInfo, SessionMessageAssistantTool } from "@opencode/client"
import { sidebarActivity, sidebarChanges, sidebarStatus, sidebarTodos } from "../../src/util/sidebar"

function assistant(content: Extract<SessionMessageInfo, { type: "assistant" }>["content"]): SessionMessageInfo {
  return {
    id: "msg-test",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content,
    time: { created: 0 },
  }
}

test("shows explicit current-turn todos but ignores examples and stale previous-turn lists", () => {
  const messages: SessionMessageInfo[] = [
    assistant([{ type: "text", text: "```md\n- [ ] example\n```\n- [x] Read files\n- [ ] Run checks" }]),
  ]
  expect(sidebarTodos(messages)).toEqual([
    { text: "Read files", done: true, status: "completed" },
    { text: "Run checks", done: false, status: "pending" },
  ])
  expect(sidebarTodos([...messages, { id: "user", type: "user", text: "New task", time: { created: 1 } }])).toEqual([])
  expect(sidebarTodos([assistant([{ type: "text", text: "I plan to check your files." }])])).toEqual([])
})

test("changes include successful edits only, aggregate repeated files and reject missing counts", () => {
  const edit = (id: string, state: SessionMessageAssistantTool["state"]): SessionMessageAssistantTool => ({
    type: "tool",
    name: "edit",
    id,
    state,
    time: { created: 0 },
  })
  const metadata = { files: [{ file: "src/app.ts", additions: 12, deletions: 3 }] }
  const messages = [
    assistant([
      edit("preview", { status: "running", input: {}, metadata }),
      edit("one", { status: "completed", input: {}, metadata, content: [{ type: "text", text: "edited" }] }),
      edit("two", {
        status: "completed",
        input: {},
        metadata: { files: [{ file: "src/app.ts", additions: 2, deletions: 1 }, { file: "unknown" }] },
        content: [{ type: "text", text: "edited" }],
      }),
    ]),
  ]
  expect(sidebarChanges(messages)).toEqual([{ path: "src/app.ts", status: "modified", additions: 14, deletions: 4 }])
  expect(sidebarChanges([assistant([edit("preview", { status: "running", input: {}, metadata })])])).toEqual([])
})

test("structured todos survive follow-ups, reflect current statuses, and clear explicitly", () => {
  const update = (todos: { content: string; status: string }[]): SessionMessageInfo =>
    assistant([
      {
        type: "tool",
        name: "todowrite",
        id: "todo",
        time: { created: 0 },
        state: {
          status: "completed",
          input: { todos },
          content: [{ type: "text", text: "Updated tasks" }],
          metadata: { todos },
        },
      },
    ])
  const messages = [
    update([{ content: "Implement UI", status: "in_progress" }]),
    { id: "user", type: "user" as const, text: "Continue carefully", time: { created: 1 } },
  ]
  expect(sidebarTodos(messages)).toEqual([{ text: "Implement UI", status: "in_progress", done: false }])
  expect(sidebarTodos([...messages, update([{ content: "Implement UI", status: "completed" }])])[0].done).toBeTrue()
  expect(sidebarTodos([...messages, update([])])).toEqual([])
})

test("shows created, edited and deleted files, including successful writes from older sessions", () => {
  const tool = (
    name: string,
    input: Record<string, string>,
    text: string,
    files?: { file: string; status: string; additions: number; deletions: number }[],
  ): SessionMessageAssistantTool => ({
    type: "tool",
    name,
    id: text,
    time: { created: 0 },
    state: { status: "completed", input, content: [{ type: "text", text }], ...(files ? { metadata: { files } } : {}) },
  })
  const changes = sidebarChanges([
    assistant([
      tool("write", { path: "C:/project/old.ts" }, "Created file successfully: old.ts"),
      tool("edit", {}, "Edited old", [{ file: "old.ts", status: "modified", additions: 1, deletions: 0 }]),
      tool("write", { path: "new.ts" }, "Created file successfully: new.ts", [
        { file: "new.ts", status: "added", additions: 30, deletions: 0 },
      ]),
      tool("edit", {}, "Edited", [{ file: "new.ts", status: "modified", additions: 2, deletions: 1 }]),
      tool("patch", {}, "Deleted", [{ file: "removed.ts", status: "deleted", additions: 0, deletions: 6 }]),
    ]),
  ])
  expect(changes).toEqual([
    { path: "old.ts", status: "added" },
    { path: "new.ts", status: "added", additions: 32, deletions: 1 },
    { path: "removed.ts", status: "deleted", additions: 0, deletions: 6 },
  ])
})

test("an idle agent is only completed when its recorded outcome says so", () => {
  expect(sidebarStatus([], false)).toBe("Idle")
  expect(sidebarStatus([], false, "succeeded")).toBe("Completed")
  const done: SessionMessageInfo = { id: "idle", type: "idle", outcome: "succeeded", time: { created: 0 } }
  expect(sidebarStatus([done], false)).toBe("Completed")
  expect(sidebarStatus([done], true)).toBe("Running")
  expect(sidebarStatus([{ ...done, outcome: "interrupted" }], false)).toBe("Stopped")
  expect(sidebarStatus([done, { id: "new", type: "user", text: "Next task", time: { created: 1 } }], false)).toBe(
    "Idle",
  )
})

test("agent preview excludes private reasoning and raw tool input", () => {
  const messages = [
    assistant([
      { type: "reasoning", text: "private reasoning" },
      { type: "text", text: "Checking dashboard tests" },
      {
        type: "tool",
        id: "tool",
        name: "shell",
        time: { created: 0 },
        state: { status: "running", input: { secret: "not for preview" }, metadata: {} },
      },
    ]),
  ]
  expect(sidebarActivity(messages)).toEqual(["Checking dashboard tests", "shell · running"])
})
