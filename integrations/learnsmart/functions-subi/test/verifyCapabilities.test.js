// test/verifyCapabilities.test.js — Phase 17I: inspect_v1/verify_v1 argument
// validation, tool gating, and managed prompt concepts. Route preflight and
// provider-bundle order live in managedAgentRoute.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAgentBody, agentSystemPrompt } = require("../src/services/managedAgentValidator");

function turn(toolName, args, capability = "verify_v1", mode = "build") {
  return {
    protocolVersion: 1, modelKey: "mdl_a", agentMode: mode,
    clientRunId: "run-1", providerRequestIndex: 0, toolCapabilityVersion: capability,
    canonicalTurns: [
      { role: "user", content: "verify the project" },
      { role: "assistantToolCalls", text: "", toolCalls: [{ providerCallId: "c1", toolName, args }] },
      { role: "toolResult", providerCallId: "c1", toolName, content: "done", isError: false },
    ],
  };
}

function askTurn(toolName, args) {
  return turn(toolName, args, "inspect_v1", "ask");
}

test("verify args: strict closed shapes per tool", () => {
  assert.doesNotThrow(() => validateAgentBody(turn("run_typecheck", {})));
  assert.doesNotThrow(() => validateAgentBody(turn("run_lint", { projectPath: "packages/app" })));
  assert.doesNotThrow(() => validateAgentBody(turn("run_tests", { scope: "workspace" })));
  assert.doesNotThrow(() => validateAgentBody(turn("run_tests", { paths: ["a.test.ts"], pattern: "foo" })));
  assert.doesNotThrow(() => validateAgentBody(askTurn("get_diagnostics", { severities: ["error", "warning"] })));
  assert.doesNotThrow(() => validateAgentBody(askTurn("grep", { pattern: "foo", regex: true, contextLines: 2 })));
  assert.doesNotThrow(() => validateAgentBody(askTurn("glob", { pattern: "**/*.ts" })));
  assert.doesNotThrow(() => validateAgentBody(askTurn("list_directory", { path: "src", depth: 2 })));
});

test("verify args: unknown fields, enums, arrays, and bounds reject", () => {
  for (const bad of [
    ["run_typecheck", { executable: "tsc" }],
    ["run_lint", { fix: true }],
    ["run_build", { args: ["x"] }],
    ["run_tests", { scope: "everything" }],
    ["run_tests", { paths: Array.from({ length: 21 }, (_, i) => `f${i}`) }],
    ["run_tests", { pattern: "x".repeat(201) }],
    ["run_tests", { paths: "a.test.ts" }],
    ["get_diagnostics", { severities: ["critical"] }],
    ["get_diagnostics", { severities: [] }],
    ["get_diagnostics", { severities: ["error", "error"] }],
    ["get_diagnostics", { paths: Array.from({ length: 51 }, (_, i) => `f${i}`) }],
    ["grep", { pattern: "" }],
    ["grep", { pattern: "x".repeat(501) }],
    ["grep", { pattern: "x", contextLines: 6 }],
    ["grep", { pattern: "x", regex: "yes" }],
    ["glob", {}],
    ["glob", { pattern: "x", maxResults: 501 }],
    ["list_directory", { depth: 4 }],
    ["list_directory", { maxEntries: 0 }],
  ]) {
    assert.throws(() => validateAgentBody(turn(bad[0], bad[1])), `reject ${bad[0]} ${JSON.stringify(bad[1]).slice(0, 60)}`);
  }
});

test("inspect gating: ask forbids propose, plan allows it, build tools stay build-only", () => {
  assert.throws(() => validateAgentBody(askTurn("propose_patch", { path: "a" })));
  assert.doesNotThrow(() => validateAgentBody(turn("propose_patch", { path: "a" }, "inspect_v1", "plan")));
  assert.throws(() => validateAgentBody(turn("apply_patch", { patchId: "p" }, "inspect_v1", "plan")));
  assert.throws(() => validateAgentBody(turn("run_tests", {}, "read_v1", "ask")));
  assert.throws(() => validateAgentBody(turn("grep", { pattern: "x" }, "read_v1", "ask")));
  assert.doesNotThrow(() => validateAgentBody(turn("run_command", { executable: "node" }, "verify_v1", "build")));
  assert.doesNotThrow(() => validateAgentBody(turn("run_tests", {}, "verify_v1", "build")));
});

test("managed inspect prompt: read-only teaching without execution", () => {
  const ask = agentSystemPrompt("ask", "inspect_v1");
  for (const token of ["list_directory", "glob", "grep", "get_diagnostics"]) {
    assert.ok(ask.includes(token), `ask prompt teaches ${token}`);
  }
  assert.ok(/never run verification/i.test(ask), "ask forbids verification");
  assert.ok(!/run_typecheck|run_tests/.test(ask), "ask names no run_* tools");
  const plan = agentSystemPrompt("plan", "inspect_v1");
  assert.ok(plan.includes("propose_patch"), "plan may propose");
  assert.ok(/plan artifact, not an executed change/i.test(plan), "plan artifact semantics");
  assert.ok(/never apply/i.test(plan), "plan never applies");
});

test("managed verify prompt: evidence, repair bound, and prohibitions", () => {
  const build = agentSystemPrompt("build", "verify_v1");
  for (const token of ["run_typecheck", "run_lint", "run_build", "run_tests", "list_directory", "get_diagnostics"]) {
    assert.ok(build.includes(token), `verify prompt teaches ${token}`);
  }
  assert.ok(/never claim tests pass/i.test(build), "no pass claim without evidence");
  assert.ok(/focused tests never prove the full suite/i.test(build), "focused ≠ full");
  assert.ok(/empty diagnostics snapshot never proves the build/i.test(build), "diagnostics ≠ proof");
  assert.ok(/at most 3 repair cycles/i.test(build), "max 3 repair cycles");
  assert.ok(/no git mutation/i.test(build), "no git");
  assert.ok(/no automatic installs/i.test(build), "no auto install");
  assert.ok(/nonzero exit with a failed status is a normal verification failure/i.test(build), "exit semantics");
});
