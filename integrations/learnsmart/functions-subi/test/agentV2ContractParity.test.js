// test/agentV2ContractParity.test.js — Phase 18 repair: authoritative
// extension↔backend contract parity for EVERY agent_v2 tool.
//
// HOST IS EXECUTION AUTHORITY. The HOST_CONTRACTS table below mirrors the
// extension ToolRegistry inputSchema field-for-field (host file:line refs
// inline). The backend advertisement (buildManagedAgentTools) and the backend
// validator (validateAgentBody) must both match it. Any drift on either side
// fails here before production.
//
// Host sources:
//   H1  Subi/src/tools/git/buildGitStatusTool.ts:32-40
//   H2  Subi/src/tools/git/buildGitDiffTool.ts:35-57
//   H3  Subi/src/tools/git/buildGitLogTool.ts:34-48
//   H4  Subi/src/tools/git/buildGitStageTool.ts:42-56
//   H5  Subi/src/tools/git/buildGitUnstageTool.ts:39-53
//   H6  Subi/src/tools/git/buildGitCommitTool.ts:42-64
//   H7  Subi/src/tools/terminal/buildTerminalTools.ts:7-17
//   H8  Subi/src/tools/terminal/buildShellTool.ts:18-23
//   H9  Subi/src/tools/verification/buildVerificationTools.ts:74-81
//   H10 Subi/src/tools/workspace/GetWorkspaceInfoTool.ts (no args)
//   H11 Subi/src/tools/workspace/ListDirectoryTool.ts:43-47
//   H12 Subi/src/tools/files/FindFilesTool.ts:40-48
//   H13 Subi/src/tools/search/GlobTool.ts:37-41
//   H14 Subi/src/tools/search/SearchTextTool.ts:45-59
//   H15 Subi/src/tools/search/GrepTool.ts:68-77
//   H16 Subi/src/tools/files/ReadFileTool.ts:46-66
//   H17 Subi/src/tools/diagnostics/GetDiagnosticsTool.ts:20-24
//   H18 Subi/src/tools/edit/ProposePatchTool.ts:42-63
//   H19 Subi/src/tools/edit/ApplyPatchTool.ts:42-50 (patchId max 200)
//   H20 Subi/src/tools/edit/UndoChangeTool.ts:33-41 (changeId max 200)
//   H21 Subi/src/tools/edit/buildMkdirTool.ts:18-20
//   H22 Subi/src/tools/lsp/buildLspTool.ts:36-42
//   H23 Subi/src/tools/todo/buildTodoTools.ts (read: no args; write: todos max 20000)
//   H24 Subi/src/tools/task/buildTaskTool.ts:23-26
//   H25 Subi/src/tools/question/buildQuestionTool.ts:18-20
//   H26 Subi/src/tools/skills/buildSkillTool.ts (load: name max 100; list: no args)
//   H27 Subi/src/tools/web/buildWebTools.ts (fetch: url max 2000; search: query max 500)
//   H28 Subi/src/tools/batch/buildBatchTool.ts:20-22 (calls max 32000)
//   H29 Subi/src/tools/external/buildExternalTools.ts (read/shell: path max 2000; write: +content max 262144)
//   ENG Subi/src/services/git/GitEngine.ts + GitTypes.ts GIT_LIMITS
//         (log 1-50, stage/unstage 1-50 paths, subject 1-120 code points, body 2000,
//          diff scope working|staged, path/rootId bounds)
//   TERM Subi/src/services/terminal/TerminalEngine.ts:288-289 + ProcessRegistry.ts:25
//         (processId is randomUUID(); host enforces /^[a-f0-9-]{36}$/)
//
// Documented intentional narrowings (NOT drift):
//   N1 run_tests agent_v2 omits paths/pattern and restricts scope to
//      ["workspace"]: host accepts those fields structurally but refuses every
//      focused run with VERIFICATION_NOT_CONFIGURED (H9 + parseTestScope).
//      Frozen verify_v1 keeps the broad shape for backward compat.
//   N2 Host path/query-typed fields surface as backend {type:"string"}: the
//      provider codec has no path/query primitives (lossless: both are
//      bounded strings host-side).
//   N3 Host read_file offset/limit are ToolInputField "number" but execution
//      requires safe integers; backend advertises {type:"integer"} (safe narrowing).
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildManagedAgentTools, AGENT_V2_BUILD_NAMES } = require("../src/services/managedAgentTools");
const { validateAgentBody } = require("../src/services/managedAgentValidator");

// kind: string|integer|boolean|strings(array of strings)|enum
// Bounds mirror host maxLength/minimum/maximum/required exactly.
const HOST_CONTRACTS = {
  get_workspace_info: { fields: {} },
  list_directory: { fields: {
    path: { kind: "string", maxLength: 1000 },
    depth: { kind: "integer", min: 1, max: 3 },
    maxEntries: { kind: "integer", min: 1, max: 500 } } },
  find_files: { fields: { filter: { kind: "string", maxLength: 200 } } },
  glob: { fields: {
    pattern: { kind: "string", maxLength: 200, required: true },
    basePath: { kind: "string", maxLength: 1000 },
    maxResults: { kind: "integer", min: 1, max: 500 } } },
  search_text: { fields: {
    query: { kind: "string", maxLength: 200, required: true },
    mode: { kind: "enum", values: ["content", "files"] } } },
  grep: { fields: {
    pattern: { kind: "string", maxLength: 500, required: true },
    path: { kind: "string", maxLength: 1000 },
    includeGlob: { kind: "string", maxLength: 200 },
    excludeGlob: { kind: "string", maxLength: 200 },
    regex: { kind: "boolean" },
    caseSensitive: { kind: "boolean" },
    contextLines: { kind: "integer", min: 0, max: 5 },
    maxResults: { kind: "integer", min: 1, max: 200 } } },
  read_file: { fields: {
    path: { kind: "string", maxLength: 1000, required: true },
    offset: { kind: "integer", min: 0 },
    limit: { kind: "integer", min: 1, max: 12000 } } },
  get_diagnostics: { fields: {
    paths: { kind: "strings", maxItems: 50, maxLength: 1000 },
    severities: { kind: "enumArray", values: ["error", "warning", "information", "hint"], maxItems: 4 },
    maxResults: { kind: "integer", min: 1, max: 200 } } },
  git_status: { fields: { workspaceRootId: { kind: "string", maxLength: 200 } } },
  git_diff: { fields: {
    scope: { kind: "enum", values: ["working", "staged"], required: true, maxLength: 20 },
    path: { kind: "string", maxLength: 1000 },
    workspaceRootId: { kind: "string", maxLength: 200 } } },
  git_log: { fields: {
    limit: { kind: "integer", min: 1, max: 50 },
    workspaceRootId: { kind: "string", maxLength: 200 } } },
  git_stage: { fields: {
    paths: { kind: "strings", required: true, minItems: 1, maxItems: 50, maxLength: 1000 },
    workspaceRootId: { kind: "string", maxLength: 200 } } },
  git_unstage: { fields: {
    paths: { kind: "strings", required: true, minItems: 1, maxItems: 50, maxLength: 1000 },
    workspaceRootId: { kind: "string", maxLength: 200 } } },
  git_commit: { fields: {
    subject: { kind: "string", maxLength: 120, required: true },
    body: { kind: "string", maxLength: 2000 },
    workspaceRootId: { kind: "string", maxLength: 200 } } },
  lsp: { fields: {
    action: { kind: "enum", values: ["document_symbols", "workspace_symbols", "definition", "references", "implementation", "hover", "call_hierarchy"], required: true, maxLength: 32 },
    path: { kind: "string", maxLength: 1000 },
    query: { kind: "string", maxLength: 500 },
    line: { kind: "integer" },
    character: { kind: "integer" } } },
  todo_read: { fields: {} },
  todo_write: { fields: { todos: { kind: "string", maxLength: 20000, required: true } } },
  propose_patch: { fields: {
    operation: { kind: "string", maxLength: 16 },
    op: { kind: "string", maxLength: 16 },
    path: { kind: "string", maxLength: 1000 },
    filePath: { kind: "string", maxLength: 1000 },
    oldString: { kind: "string", maxLength: 49152 },
    newString: { kind: "string", maxLength: 49152 },
    replaceAll: { kind: "boolean" },
    content: { kind: "string", maxLength: 262144 },
    from: { kind: "string", maxLength: 1000 },
    to: { kind: "string", maxLength: 1000 },
    expectedHash: { kind: "string", maxLength: 128 },
    eol: { kind: "string", maxLength: 4 },
    operationsJson: { kind: "string", maxLength: 262144 } } },
  apply_patch: { fields: { patchId: { kind: "string", maxLength: 200, required: true } } },
  undo_change: { fields: { changeId: { kind: "string", maxLength: 200, required: true } } },
  create_directory: { fields: { path: { kind: "string", maxLength: 1000, required: true } } },
  run_command: { fields: {
    executable: { kind: "string", maxLength: 1000, required: true },
    args: { kind: "strings", maxItems: 128, maxLength: 4096 },
    cwd: { kind: "string", maxLength: 1000 },
    timeoutMs: { kind: "integer", min: 1, max: 600000 },
    executionMode: { kind: "enum", values: ["foreground", "background"], maxLength: 10 } } },
  run_shell_command: { fields: {
    shell: { kind: "enum", values: ["powershell", "pwsh", "cmd", "bash", "sh", "zsh"], required: true, maxLength: 20 },
    command: { kind: "string", maxLength: 8000, required: true },
    cwd: { kind: "string", maxLength: 1000 },
    timeoutMs: { kind: "integer", min: 1, max: 600000 } } },
  terminal_status: { fields: { processId: { kind: "string", maxLength: 36, required: true } } },
  cancel_command: { fields: { processId: { kind: "string", maxLength: 36, required: true } } },
  delegate_task: { fields: {
    task: { kind: "string", maxLength: 2000, required: true },
    scope: { kind: "string", maxLength: 2000 } } },
  ask_user: { fields: { questions: { kind: "string", maxLength: 8000, required: true } } },
  load_skill: { fields: { name: { kind: "string", maxLength: 100, required: true } } },
  list_skills: { fields: {} },
  web_fetch: { fields: { url: { kind: "string", maxLength: 2000, required: true } } },
  web_search: { fields: { query: { kind: "string", maxLength: 500, required: true } } },
  batch_tools: { fields: { calls: { kind: "string", maxLength: 32000, required: true } } },
  external_read: { fields: { path: { kind: "string", maxLength: 2000, required: true } } },
  external_write: { fields: {
    path: { kind: "string", maxLength: 2000, required: true },
    content: { kind: "string", maxLength: 262144, required: true } } },
  external_shell: { fields: { path: { kind: "string", maxLength: 2000, required: true } } },
  run_typecheck: { fields: { projectPath: { kind: "string", maxLength: 1000 } } },
  run_lint: { fields: { projectPath: { kind: "string", maxLength: 1000 } } },
  run_build: { fields: { projectPath: { kind: "string", maxLength: 1000 } } },
  // N1: narrowed executable contract (workspace scope only).
  run_tests: { narrowed: true, fields: {
    projectPath: { kind: "string", maxLength: 1000 },
    scope: { kind: "enum", values: ["workspace"] } } },
};

function byName(tools) {
  const map = {};
  for (const t of tools) map[t.function.name] = t.function;
  return map;
}

function checkField(toolName, fieldName, spec, prop) {
  assert.ok(prop, `${toolName}.${fieldName}: advertised`);
  if (spec.kind === "string") {
    assert.equal(prop.type, "string", `${toolName}.${fieldName}: string`);
    if (spec.maxLength !== undefined) {
      assert.equal(prop.maxLength, spec.maxLength, `${toolName}.${fieldName}: maxLength ${spec.maxLength}`);
    }
  } else if (spec.kind === "integer") {
    assert.equal(prop.type, "integer", `${toolName}.${fieldName}: integer`);
    if (spec.min !== undefined) assert.equal(prop.minimum, spec.min, `${toolName}.${fieldName}: minimum`);
    if (spec.max !== undefined) assert.equal(prop.maximum, spec.max, `${toolName}.${fieldName}: maximum`);
  } else if (spec.kind === "boolean") {
    assert.equal(prop.type, "boolean", `${toolName}.${fieldName}: boolean`);
  } else if (spec.kind === "strings") {
    assert.equal(prop.type, "array", `${toolName}.${fieldName}: array`);
    assert.equal(prop.items && prop.items.type, "string", `${toolName}.${fieldName}: string items (never flattened)`);
    if (spec.maxItems !== undefined) assert.equal(prop.maxItems, spec.maxItems, `${toolName}.${fieldName}: maxItems`);
    if (spec.minItems !== undefined) assert.equal(prop.minItems, spec.minItems, `${toolName}.${fieldName}: minItems`);
    if (spec.maxLength !== undefined) assert.equal(prop.items.maxLength, spec.maxLength, `${toolName}.${fieldName}: item maxLength`);
  } else if (spec.kind === "enum") {
    assert.equal(prop.type, "string", `${toolName}.${fieldName}: enum string`);
    assert.deepEqual(prop.enum, spec.values, `${toolName}.${fieldName}: enum values`);
    if (spec.maxLength !== undefined) assert.equal(prop.maxLength, spec.maxLength, `${toolName}.${fieldName}: maxLength`);
  } else if (spec.kind === "enumArray") {
    assert.equal(prop.type, "array", `${toolName}.${fieldName}: enum array`);
    assert.deepEqual(prop.items && prop.items.enum, spec.values, `${toolName}.${fieldName}: enum values`);
    if (spec.maxItems !== undefined) assert.equal(prop.maxItems, spec.maxItems, `${toolName}.${fieldName}: maxItems`);
  }
}

test("agent_v2 parity: all 39 BUILD tools advertised with host-exact fields", () => {
  const tools = buildManagedAgentTools("agent_v2", "build");
  assert.equal(tools.length, 39);
  assert.deepEqual(tools.map((t) => t.function.name).sort(), [...AGENT_V2_BUILD_NAMES].sort());
  assert.deepEqual(Object.keys(HOST_CONTRACTS).sort(), [...AGENT_V2_BUILD_NAMES].sort(), "parity table covers all 39");
  const map = byName(tools);
  for (const [toolName, contract] of Object.entries(HOST_CONTRACTS)) {
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

test("agent_v2 parity: ASK/PLAN projections stay mode-exact", () => {
  assert.equal(buildManagedAgentTools("agent_v2", "ask").length, 20);
  assert.equal(buildManagedAgentTools("agent_v2", "plan").length, 23);
  const ask = byName(buildManagedAgentTools("agent_v2", "ask"));
  assert.ok(!ask.apply_patch && !ask.git_stage && !ask.run_command, "ask carries no build tools");
  const plan = byName(buildManagedAgentTools("agent_v2", "plan"));
  assert.ok(plan.propose_patch && plan.delegate_task && !plan.apply_patch, "plan carries plan tools only");
});

function turn(toolName, args, capability = "agent_v2", mode = "build") {
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

test("agent_v2 validator: host-compatible calls pass, mismatched shapes reject", () => {
  const valid = [
    ["git_status", {}],
    ["git_status", { workspaceRootId: "subi" }],
    ["git_diff", { scope: "working" }],
    ["git_diff", { scope: "staged", path: "src/a.ts", workspaceRootId: "subi" }],
    ["git_log", {}],
    ["git_log", { limit: 5 }],
    ["git_stage", { paths: ["a.ts", "src/b.ts"] }],
    ["git_unstage", { paths: ["a.ts"], workspaceRootId: "subi" }],
    ["git_commit", { subject: "Fix bug" }],
    ["git_commit", { subject: "Fix bug", body: "Details." }],
    ["run_command", { executable: "node", args: ["--version"] }],
    ["run_shell_command", { shell: "powershell", command: "Get-ChildItem" }],
    ["terminal_status", { processId: "123e4567-e89b-12d3-a456-426614174000" }],
    ["cancel_command", { processId: "123e4567-e89b-12d3-a456-426614174000" }],
    ["run_tests", {}],
    ["run_tests", { scope: "workspace" }],
    ["lsp", { action: "definition", path: "src/a.ts", line: 1, character: 2 }],
    ["read_file", { path: "src/a.ts", offset: 0, limit: 100 }],
    ["search_text", { query: "hello" }],
    ["create_directory", { path: "src/new" }],
    ["external_write", { path: "/tmp/x.txt", content: "hi" }],
  ];
  for (const [name, args] of valid) {
    assert.doesNotThrow(() => validateAgentBody(turn(name, args)), `accept ${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
  const invalid = [
    ["git_status", { path: "src" }],
    ["git_diff", {}],
    ["git_diff", { scope: "main..dev" }],
    ["git_diff", { scope: "working", path: "src" , revision: "HEAD" }],
    ["git_log", { path: "src" }],
    ["git_log", { limit: 500 }],
    ["git_stage", { paths: "a.ts src/b.ts" }],
    ["git_stage", { paths: [] }],
    ["git_stage", { paths: ["a.ts"], message: "x" }],
    ["git_unstage", { paths: "a.ts" }],
    ["git_commit", { message: "Fix bug" }],
    ["git_commit", { subject: "" }],
    ["git_commit", { subject: "x".repeat(121) }],
    ["run_command", { executable: "node", args: "x" }],
    ["run_shell_command", { shell: "fish", command: "ls" }],
    ["terminal_status", { processId: "not-a-uuid-at-all-00000000000000" }],
    ["terminal_status", {}],
    ["run_tests", { scope: "file", paths: ["a.ts"] }],
    ["run_tests", { pattern: "foo" }],
    ["run_tests", { scope: "related" }],
    ["lsp", { action: "rename" }],
    ["read_file", { path: "a.ts", limit: 99999 }],
    ["search_text", { query: "x" }],
    ["git_log", { limit: 1, bogus: true }],
  ];
  for (const [name, args] of invalid) {
    assert.throws(() => validateAgentBody(turn(name, args)), `reject ${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
});

test("frozen bundles unchanged: counts, verify_v1 breadth, legacy envelopes", () => {
  const { buildManagedAgentTools: build } = require("../src/services/managedAgentTools");
  assert.equal(build("read_v1", "ask").length, 4);
  assert.equal(build("file_v1", "plan").length, 5);
  assert.equal(build("file_v2", "build").length, 7);
  assert.equal(build("terminal_v1", "build").length, 10);
  assert.equal(build("inspect_v1", "ask").length, 8);
  assert.equal(build("inspect_v1", "plan").length, 9);
  assert.equal(build("verify_v1", "build").length, 18);
  // verify_v1 keeps its historical broad run_tests (backward compat).
  const vrf = byName(build("verify_v1", "build"));
  assert.deepEqual(Object.keys(vrf.run_tests.parameters.properties).sort(),
    ["paths", "pattern", "projectPath", "scope"].sort());
  // verify_v1 focused args still validate exactly as before.
  assert.doesNotThrow(() => validateAgentBody(turn("run_tests", { paths: ["a.test.ts"], pattern: "foo" }, "verify_v1", "build")));
  assert.doesNotThrow(() => validateAgentBody(turn("run_command", { executable: "node" }, "verify_v1", "build")));
  assert.doesNotThrow(() => validateAgentBody(turn("run_command", { executable: "node" }, "terminal_v1", "build")));
});
