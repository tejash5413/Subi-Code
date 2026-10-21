import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"
import { wordmark } from "../src/logo"

test.each([
  [160, 45],
  [80, 24],
  [44, 24],
] as const)("welcome remains usable at %s × %s", async (width, height) => {
  await using setup = await createAppFixture({ width, height })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  const frame = setup.captureCharFrame()
  expect(frame).toContain("2.0.1")
  expect(frame).toContain(width >= wordmark[0].length + 4 && height >= 26 ? wordmark[0].trim() : "SubiCode")
  expect(
    frame
      .split("\n")
      .filter((line) => line.includes("2.0.1"))
      .every((line) => line.trim() === "2.0.1"),
  ).toBeTrue()
  expect(frame.split("\n").every((line) => Array.from(line.trimEnd()).length <= width)).toBeTrue()
  await setup.mockInput.typeText("Review this project")
  await setup.waitForFrame((frame) => frame.includes("Review this project"))
})

test("parallel agent inspection stays in the sidebar and Esc returns without interrupting the main task", async () => {
  const root = {
    id: "ses_silver",
    title: "Dashboard progress",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 2 },
  }
  const child = { ...root, id: "ses_child", parentID: root.id, title: "Test coverage" }
  const messages = [
    {
      id: "msg_root",
      type: "assistant",
      agent: "build",
      model: { providerID: "demo", id: "model" },
      content: [
        { type: "text", text: "Main task remains visible." },
        {
          type: "tool",
          id: "todo-silver",
          name: "todowrite",
          time: { created: 0, completed: 1 },
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Inspect files", status: "completed" },
                { content: "Run checks", status: "in_progress" },
              ],
            },
            metadata: {
              todos: [
                { content: "Inspect files", status: "completed" },
                { content: "Run checks", status: "in_progress" },
              ],
            },
            content: [{ type: "text", text: "1/2 tasks completed" }],
          },
        },
        {
          type: "tool",
          id: "edit-silver",
          name: "edit",
          time: { created: 0, completed: 1 },
          state: {
            status: "completed",
            input: {},
            metadata: {
              files: [
                { file: "src/Dashboard.tsx", patch: "", status: "modified", additions: 12, deletions: 3 },
                { file: "src/Progress.tsx", patch: "", status: "added", additions: 20, deletions: 0 },
                { file: "src/Old.tsx", patch: "", status: "deleted", additions: 0, deletions: 8 },
              ],
            },
            content: [{ type: "text", text: "Updated dashboard" }],
          },
        },
      ],
      tokens: { input: 2300, output: 140, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0 },
    },
  ]
  let mutations = 0
  await using setup = await createAppFixture({
    width: 160,
    height: 45,
    args: { sessionID: root.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: (url, request) => {
      if (request.method !== "GET") mutations++
      if (url.pathname === "/api/session")
        return json({ data: url.searchParams.has("parentID") ? [child] : [root, child], cursor: {} })
      if (url.pathname === `/api/session/${root.id}`) return json({ data: root })
      if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
      if (url.pathname === `/api/session/${root.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${child.id}/message`)
        return json({
          data: [{ ...messages[0], id: "msg_child", content: [{ type: "text", text: "Checking dashboard tests" }] }],
          cursor: {},
        })
      if (/\/inbox$/.test(url.pathname)) return json({ data: [] })
    },
  })
  await setup.ready
  await waitForHighlightedFrame(
    setup,
    (frame) =>
      frame.includes("Parallel agents") &&
      frame.includes("Main task remains visible") &&
      frame.includes("[x] Inspect files") &&
      frame.includes("[>] Run checks"),
  )
  const before = setup.captureCharFrame()
  expect(before).toContain("SubiCode 2.0.1")
  expect(before).toContain("Todo")
  expect(before).toContain("Context")
  expect(before).toContain("Changes")
  expect(before).toContain("+12")
  expect(before).toContain("−3")
  expect(before).toContain("Total +32 −11")
  expect(before).toContain("Created")
  expect(before).toContain("Edited")
  expect(before).toContain("Deleted")
  const lines = before.split("\n")
  const row = lines.findIndex((line) => line.includes("› Test coverage"))
  expect(row).toBeGreaterThanOrEqual(0)
  await setup.mockMouse.click(lines[row].indexOf("› Test coverage") + 3, row)
  await setup.waitForFrame((frame) => frame.includes("Checking dashboard tests") && frame.includes("Back · Esc"))
  expect(setup.captureCharFrame()).toContain("Main task remains visible")
  setup.mockInput.pressKey("ESCAPE")
  await setup.waitForFrame((frame) => frame.includes("Parallel agents") && !frame.includes("Back · Esc"))
  expect(setup.captureCharFrame()).toContain("Main task remains visible")
  expect(mutations).toBe(0)
})

test("a large successful file write stays compact in a real session and expands on click", async () => {
  const session = {
    id: "ses_large_write",
    title: "Create a large file",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 2 },
  }
  const message = {
    id: "msg_large_write",
    type: "assistant",
    agent: "build",
    model: { providerID: "demo", id: "model" },
    content: [
      {
        type: "tool",
        id: "write-large",
        name: "write",
        time: { created: 0, completed: 1 },
        state: {
          status: "completed",
          input: {
            path: "src/large.ts",
            content: Array.from({ length: 1000 }, (_, i) => `const line${String(i + 1).padStart(4, "0")} = ${i}`).join(
              "\n",
            ),
          },
          metadata: { files: [{ file: "src/large.ts", status: "added", additions: 1000, deletions: 0 }] },
          content: [{ type: "text", text: "Created file successfully: src/large.ts" }],
        },
      },
      { type: "text", text: "The file is ready for review." },
    ],
    time: { created: 0 },
  }
  await using setup = await createAppFixture({
    width: 160,
    height: 60,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [message], cursor: {} })
      if (/\/inbox$/.test(url.pathname)) return json({ data: [] })
    },
  })
  await setup.ready
  await waitForHighlightedFrame(setup, (frame) => frame.includes("line0008") && frame.includes("▼ Expand"))
  await setup.renderOnce()
  const before = setup.captureCharFrame()
  expect(before).not.toContain("line0009")
  expect(before).toContain("Created")
  expect(before).toContain("+1000")
  expect(before).toContain("The file is ready for review.")
  const row = before.split("\n").findIndex((line) => line.includes("▼ Expand"))
  await setup.mockMouse.click(before.split("\n")[row].indexOf("▼ Expand") + 3, row)
  await waitForHighlightedFrame(setup, (frame) => frame.includes("▲ Collapse") && frame.includes("line0020"))
  expect(setup.captureCharFrame()).not.toContain("line0021")
  expect(setup.captureCharFrame()).toContain("The file is ready for review.")
  setup.renderer.clearSelection()
  const expanded = setup.captureCharFrame().split("\n")
  const collapse = expanded.findIndex((line) => line.includes("▲ Collapse"))
  await setup.mockMouse.click(expanded[collapse].indexOf("▲ Collapse") + 7, collapse)
  await setup.waitForFrame((frame) => frame.includes("▼ Expand") && !frame.includes("line0009"))
  const collapsed = setup.captureCharFrame().split("\n")
  const prompt = collapsed.findIndex((line) => line.includes("│  ›"))
  expect(prompt).toBeGreaterThanOrEqual(0)
  await setup.mockMouse.click(collapsed[prompt].indexOf("│  ›") + 5, prompt)
  await setup.mockInput.typeText("Continue with the next task")
  await setup.waitForFrame((frame) => frame.includes("Continue with the next task"))
})
