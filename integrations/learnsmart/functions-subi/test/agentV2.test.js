// test/agentV2.test.js — Phase 18: agent_v2 additive bundle (old versions frozen).
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildManagedAgentTools, isManagedAgentTool, AGENT_V2_ASK_NAMES, AGENT_V2_PLAN_NAMES, AGENT_V2_BUILD_NAMES } = require("../src/services/managedAgentTools");
const { validateAgentBody } = require("../src/services/managedAgentValidator");

function turn(toolName, args, capability, mode) {
  return {
    protocolVersion: 1, modelKey: "mdl_a", agentMode: mode,
    clientRunId: "run-1", providerRequestIndex: 0, toolCapabilityVersion: capability,
    canonicalTurns: [
      { role: "user", content: "hello" },
      { role: "assistantToolCalls", text: "", toolCalls: [{ providerCallId: "c1", toolName, args }] },
      { role: "toolResult", providerCallId: "c1", toolName, content: "done", isError: false },
    ],
  };
}

test("agent_v2 schemas: ask 20 / plan 23 / build 39, backend never executes", () => {
  assert.equal(buildManagedAgentTools("agent_v2", "ask").length, 20);
  assert.equal(buildManagedAgentTools("agent_v2", "plan").length, 23);
  assert.equal(buildManagedAgentTools("agent_v2", "build").length, 39);
  assert.ok(AGENT_V2_ASK_NAMES.includes("lsp"));
  assert.ok(AGENT_V2_BUILD_NAMES.includes("run_shell_command"));
  assert.ok(isManagedAgentTool("run_shell_command", "agent_v2"));
  assert.equal(isManagedAgentTool("run_shell_command", "verify_v1"), false);
});

test("agent_v2 validation: mode gating, no fallback", () => {
  assert.doesNotThrow(() => validateAgentBody(turn("lsp", { action: "definition" }, "agent_v2", "ask")));
  assert.doesNotThrow(() => validateAgentBody(turn("delegate_task", { task: "explore" }, "agent_v2", "plan")));
  assert.doesNotThrow(() => validateAgentBody(turn("run_shell_command", { shell: "powershell", command: "Get-ChildItem" }, "agent_v2", "build")));
  assert.throws(() => validateAgentBody(turn("apply_patch", { patchId: "p" }, "agent_v2", "ask")));
  assert.throws(() => validateAgentBody(turn("run_shell_command", { shell: "bash", command: "ls" }, "agent_v2", "plan")));
});

test("frozen versions untouched", () => {
  assert.equal(buildManagedAgentTools("verify_v1", "build").length, 18);
  assert.equal(buildManagedAgentTools("inspect_v1", "ask").length, 8);
});
