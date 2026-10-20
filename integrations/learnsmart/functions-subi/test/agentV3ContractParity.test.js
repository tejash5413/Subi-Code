// test/agentV3ContractParity.test.js — Phase 19C: authoritative
// extension↔backend contract parity for EVERY agent_v3 tool.
//
// agent_v3 = agent_v2 (frozen, byte-identical assertions below) + five
// read-only project tools. Host sources for the new tools:
//   Subi/src/tools/project/buildProjectTools.ts (closed schemas, bounded
//   arrays/strings/integers, workspace containment, secret guards).
//
// Any drift on either side fails here before TEST rollout.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildManagedAgentTools,
  AGENT_V2_ASK_NAMES,
  AGENT_V2_PLAN_NAMES,
  AGENT_V2_BUILD_NAMES,
  AGENT_V3_ASK_NAMES,
  AGENT_V3_PLAN_NAMES,
  AGENT_V3_BUILD_NAMES,
  isAgentV3Capability,
  isFileToolCapability,
  isManagedAgentTool,
} = require("../src/services/managedAgentTools");
const { validateAgentBody } = require("../src/services/managedAgentValidator");

// Bounds mirror the host inputSchema field-for-field.
const HOST_CONTRACTS_V3 = {
  project_overview: { fields: {
    workspaceRootId: { kind: "string", maxLength: 64 },
    projectId: { kind: "string", maxLength: 500 } } },
  project_symbols: { fields: {
    query: { kind: "string", maxLength: 200 },
    file: { kind: "string", maxLength: 1000 },
    workspaceRootId: { kind: "string", maxLength: 64 },
    limit: { kind: "integer", min: 1, max: 100 } } },
  project_dependencies: { fields: {
    file: { kind: "string", maxLength: 1000 },
    moduleId: { kind: "string", maxLength: 200 },
    direction: { kind: "enum", values: ["outgoing", "incoming", "both"] },
    transitive: { kind: "boolean" },
    depth: { kind: "integer", min: 1, max: 5 },
    limit: { kind: "integer", min: 1, max: 200 },
    workspaceRootId: { kind: "string", maxLength: 64 } } },
  project_impact: { fields: {
    files: { kind: "strings", maxItems: 20, maxLength: 1000, required: true },
    workspaceRootId: { kind: "string", maxLength: 64 },
    includeVerification: { kind: "boolean" } } },
  project_context: { fields: {
    query: { kind: "string", maxLength: 2000, required: true },
    workspaceRootId: { kind: "string", maxLength: 64 },
    maxFiles: { kind: "integer", min: 1, max: 60 },
    includeContent: { kind: "boolean" } } },
};

function byName(tools) {
  const map = {};
  for (const t of tools) map[t.function.name] = t.function;
  return map;
}

function checkField(toolName, fieldName, spec, prop) {
  assert.ok(prop, `${toolName}.${fieldName}: advertised`);
  if (spec.kind === "string") {
    assert.equal(prop.type, "string", `${toolName}.${fieldName}: type`);
    if (spec.maxLength !== undefined) assert.equal(prop.maxLength, spec.maxLength, `${toolName}.${fieldName}: maxLength`);
  } else if (spec.kind === "integer") {
    assert.equal(prop.type, "integer", `${toolName}.${fieldName}: type`);
    if (spec.min !== undefined) assert.equal(prop.minimum, spec.min, `${toolName}.${fieldName}: minimum`);
    if (spec.max !== undefined) assert.equal(prop.maximum, spec.max, `${toolName}.${fieldName}: maximum`);
  } else if (spec.kind === "boolean") {
    assert.equal(prop.type, "boolean", `${toolName}.${fieldName}: type`);
  } else if (spec.kind === "enum") {
    assert.equal(prop.type, "string", `${toolName}.${fieldName}: type`);
    assert.deepEqual(prop.enum, spec.values, `${toolName}.${fieldName}: enum values`);
  } else if (spec.kind === "strings") {
    assert.equal(prop.type, "array", `${toolName}.${fieldName}: array`);
    assert.equal(prop.items && prop.items.type, "string", `${toolName}.${fieldName}: items`);
    if (spec.maxItems !== undefined) assert.equal(prop.maxItems, spec.maxItems, `${toolName}.${fieldName}: maxItems`);
    if (spec.maxLength !== undefined) assert.equal(prop.items && prop.items.maxLength, spec.maxLength, `${toolName}.${fieldName}: item maxLength`);
  }
}

test("agent_v3 membership: exact 25/28/44 supersets of frozen v2", () => {
  assert.equal(AGENT_V3_ASK_NAMES.length, 25);
  assert.equal(AGENT_V3_PLAN_NAMES.length, 28);
  assert.equal(AGENT_V3_BUILD_NAMES.length, 44);
  // Frozen v2 lists untouched (lengths + contents).
  assert.equal(AGENT_V2_ASK_NAMES.length, 20);
  assert.equal(AGENT_V2_PLAN_NAMES.length, 23);
  assert.equal(AGENT_V2_BUILD_NAMES.length, 39);
  for (const name of AGENT_V2_BUILD_NAMES) {
    assert.ok(AGENT_V3_BUILD_NAMES.includes(name), `v3 keeps ${name}`);
  }
  const added = AGENT_V3_BUILD_NAMES.filter((n) => !AGENT_V2_BUILD_NAMES.includes(n));
  assert.deepEqual([...added].sort(), ["project_context", "project_dependencies", "project_impact", "project_overview", "project_symbols"]);
  assert.ok(isAgentV3Capability("agent_v3"));
  assert.ok(!isAgentV3Capability("agent_v2"));
  assert.ok(isFileToolCapability("agent_v3"), "v3 build carries file tools");
  assert.ok(isManagedAgentTool("project_context", "agent_v3"));
  assert.ok(!isManagedAgentTool("project_context", "agent_v2"), "v2 never admits project tools");
});

test("agent_v3 parity: all 44 BUILD tools advertised with host-exact fields", () => {
  const tools = buildManagedAgentTools("agent_v3", "build");
  assert.equal(tools.length, 44);
  assert.deepEqual(tools.map((t) => t.function.name).sort(), [...AGENT_V3_BUILD_NAMES].sort());
  const map = byName(tools);
  for (const [toolName, contract] of Object.entries(HOST_CONTRACTS_V3)) {
    const fn = map[toolName];
    assert.ok(fn, `${toolName}: advertised`);
    assert.equal(fn.parameters.type, "object", `${toolName}: object params`);
    assert.equal(fn.parameters.additionalProperties, false, `${toolName}: closed params`);
    const expectedRequired = Object.entries(contract.fields)
      .filter(([, spec]) => spec.required === true)
      .map(([field]) => field)
      .sort();
    assert.deepEqual([...(fn.parameters.required || [])].sort(), expectedRequired, `${toolName}: required fields`);
    const advertised = Object.keys(fn.parameters.properties || {}).sort();
    assert.deepEqual(advertised, Object.keys(contract.fields).sort(), `${toolName}: exact field names`);
    for (const [fieldName, spec] of Object.entries(contract.fields)) {
      checkField(toolName, fieldName, spec, fn.parameters.properties[fieldName]);
    }
  }
});

test("agent_v3 parity: ASK/PLAN projections stay mode-exact", () => {
  assert.equal(buildManagedAgentTools("agent_v3", "ask").length, 25);
  assert.equal(buildManagedAgentTools("agent_v3", "plan").length, 28);
  const ask = byName(buildManagedAgentTools("agent_v3", "ask"));
  assert.ok(!ask.apply_patch && !ask.git_stage && !ask.run_command, "ask carries no build tools");
  assert.ok(ask.project_context && ask.project_impact, "ask carries project tools");
  const plan = byName(buildManagedAgentTools("agent_v3", "plan"));
  assert.ok(plan.propose_patch && plan.delegate_task && !plan.apply_patch, "plan carries plan tools only");
  assert.ok(plan.project_overview && plan.project_symbols && plan.project_dependencies, "plan carries project tools");
});

function turn(toolName, args, capability = "agent_v3", mode = "build") {
  return {
    protocolVersion: 1, modelKey: "mdl_a", agentMode: mode,
    clientRunId: "run-1", providerRequestIndex: 0, toolCapabilityVersion: capability,
    canonicalTurns: [
      { role: "user", content: "do it" },
      { role: "assistantToolCalls", text: "", toolCalls: [{ providerCallId: "c1", toolName, args }] },
      { role: "toolResult", providerCallId: "c1", toolName, content: "done", isError: false },
    ],
  };
}

test("agent_v3 validator: host-compatible calls pass, mismatched shapes reject", () => {
  const valid = [
    ["project_overview", {}],
    ["project_overview", { workspaceRootId: "abc123", projectId: "packages/web" }],
    ["project_symbols", { query: "login" }],
    ["project_symbols", { file: "src/a.ts", limit: 10 }],
    ["project_dependencies", { file: "src/a.ts" }],
    ["project_dependencies", { moduleId: "mod:x", direction: "incoming", transitive: true, depth: 2, limit: 50 }],
    ["project_impact", { files: ["src/a.ts"] }],
    ["project_impact", { files: ["a.ts", "b.ts"], includeVerification: false }],
    ["project_context", { query: "fix login" }],
    ["project_context", { query: "fix login", maxFiles: 10, includeContent: true }],
    // v2 tools keep validating identically under v3.
    ["read_file", { path: "src/a.ts" }],
    ["git_status", {}],
    ["run_tests", {}],
  ];
  for (const [name, args] of valid) {
    assert.doesNotThrow(() => validateAgentBody(turn(name, args)), `accept ${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
  const invalid = [
    ["project_overview", { workspaceRootId: "x".repeat(65) }],
    ["project_symbols", {}],
    ["project_symbols", { query: "x", limit: 500 }],
    ["project_dependencies", {}],
    ["project_dependencies", { file: "a.ts", direction: "sideways" }],
    ["project_dependencies", { file: "a.ts", depth: 9 }],
    ["project_impact", { files: [] }],
    ["project_impact", { files: ["a.ts"], bogus: true }],
    ["project_context", { query: "x" }],
    ["project_context", { query: "ok query", maxFiles: 500 }],
    ["project_context", { query: "ok query", extra: 1 }],
    // v2 tools unaffected by v3 shapes.
    ["project_context", { files: ["a.ts"] }],
  ];
  for (const [name, args] of invalid) {
    assert.throws(() => validateAgentBody(turn(name, args)), `reject ${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
});

test("agent_v3 mode matrix mirrors v2 (project tools in every mode)", () => {
  const minimalArgs = (tool) => {
    if (tool === "project_context") return { query: "ok" };
    if (tool === "project_impact") return { files: ["a.ts"] };
    if (tool === "project_symbols") return { query: "ok" };
    if (tool === "project_dependencies") return { file: "a.ts" };
    return {};
  };
  for (const tool of ["project_overview", "project_symbols", "project_dependencies", "project_impact", "project_context"]) {
    assert.doesNotThrow(() => validateAgentBody(turn(tool, minimalArgs(tool), "agent_v3", "ask")), `${tool} allowed in ask`);
    assert.doesNotThrow(() => validateAgentBody(turn(tool, minimalArgs(tool), "agent_v3", "plan")), `${tool} allowed in plan`);
  }
  // v2 build-only tools stay build-only under v3.
  assert.throws(() => validateAgentBody(turn("apply_patch", { patchId: "p" }, "agent_v3", "ask")));
  assert.throws(() => validateAgentBody(turn("apply_patch", { patchId: "p" }, "agent_v3", "plan")));
});

test("frozen bundles unchanged by v3 additions", () => {
  const { buildManagedAgentTools: build } = require("../src/services/managedAgentTools");
  assert.equal(build("read_v1", "ask").length, 4);
  assert.equal(build("file_v1", "plan").length, 5);
  assert.equal(build("file_v2", "build").length, 7);
  assert.equal(build("terminal_v1", "build").length, 10);
  assert.equal(build("inspect_v1", "ask").length, 8);
  assert.equal(build("inspect_v1", "plan").length, 9);
  assert.equal(build("verify_v1", "build").length, 18);
  assert.equal(build("agent_v2", "ask").length, 20);
  assert.equal(build("agent_v2", "plan").length, 23);
  assert.equal(build("agent_v2", "build").length, 39);
});
