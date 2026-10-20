import { expect, test } from "bun:test"
import { globalExtensionSources } from "../src/extension-sources"

test("editable sources stop at the global directory boundary and later plugin settings win", () => {
  const sources = globalExtensionSources([
    {
      type: "document",
      info: { plugins: ["existing", { package: "edited", options: { before: true } }], skills: ["/skills/a"] },
    },
    {
      type: "document",
      info: { plugins: [{ package: "edited", options: { after: true } }], skills: ["/skills/a", "/skills/b"] },
    },
    { type: "directory", path: "/global" },
    {
      type: "document",
      info: {
        plugins: ["project-only", { package: "edited", options: { project: true } }],
        skills: ["/project/skills"],
      },
    },
  ])
  expect([...sources.plugins]).toEqual([
    ["existing", {}],
    ["edited", { after: true }],
  ])
  expect(sources.skills).toEqual(["/skills/a", "/skills/b"])
})
