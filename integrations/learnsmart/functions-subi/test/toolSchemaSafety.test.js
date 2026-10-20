const test = require('node:test');
const assert = require('node:assert/strict');
const { buildManagedAgentTools } = require('../src/services/managedAgentTools');

// Phase 16 production: server-owned provider schemas must stay inside a
// conservative broadly-supported JSON Schema subset. Several managed models
// fail closed (or misbehave) on exotic keywords, so any drift here can turn
// every terminal turn into a wasted provider call. Host-side execution
// validation stays strict independently of this linter.
const BANNED_KEYWORDS = [
  'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
  '$ref', '$defs', 'definitions', 'dependentSchemas', 'dependentRequired',
  'unevaluatedProperties', 'unevaluatedItems', 'contains', 'patternProperties',
];
const BANNED_PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
const BANNED_TOOL_PARAMS = ['shell', 'env', 'environment', 'stdin', 'rawCommand', 'command'];

function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((v) => collectKeys(v, out));
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      out.push(k);
      collectKeys(value[k], out);
    }
  }
  return out;
}

function lintTools(tools, label) {
  assert.ok(Array.isArray(tools) && tools.length > 0, `${label}: non-empty tool list`);
  const names = tools.map((t) => t && t.function && t.function.name);
  assert.deepEqual([...new Set(names)], names, `${label}: unique tool names`);
  for (const tool of tools) {
    assert.equal(tool.type, 'function', `${label}: type=function`);
    const fn = tool.function;
    assert.equal(typeof fn.name, 'string', `${label}: name present`);
    assert.equal(typeof fn.description, 'string', `${label}: description present`);
    assert.ok(fn.description.length > 0 && fn.description.length <= 2000, `${label}/${fn.name}: bounded description`);
    assert.equal(fn.parameters && fn.parameters.type, 'object', `${label}/${fn.name}: object parameters`);
    assert.equal(fn.parameters.additionalProperties, false, `${label}/${fn.name}: closed parameters`);
    const required = fn.parameters.required || [];
    for (const r of required) {
      assert.ok(fn.parameters.properties && r in fn.parameters.properties, `${label}/${fn.name}: required ⊆ properties`);
    }
  }
  const keys = collectKeys(tools);
  for (const banned of BANNED_KEYWORDS) {
    assert.ok(!keys.includes(banned), `${label}: no provider-unsafe keyword ${banned}`);
  }
  for (const banned of BANNED_PROTO_KEYS) {
    assert.ok(!keys.includes(banned), `${label}: no prototype pollution key ${banned}`);
  }
  const params = tools.flatMap((t) => Object.keys((t.function.parameters || {}).properties || {}));
  for (const banned of BANNED_TOOL_PARAMS) {
    assert.ok(!params.includes(banned), `${label}: no authority field ${banned}`);
  }
}

test('provider schema subset: read_v1 ask (4 tools)', () => {
  const tools = buildManagedAgentTools('read_v1', 'ask');
  assert.equal(tools.length, 4);
  lintTools(tools, 'read_v1/ask');
});

test('provider schema subset: file_v2 plan (5) and build (7)', () => {
  const plan = buildManagedAgentTools('file_v2', 'plan');
  assert.equal(plan.length, 5);
  lintTools(plan, 'file_v2/plan');
  const build = buildManagedAgentTools('file_v2', 'build');
  assert.equal(build.length, 7);
  lintTools(build, 'file_v2/build');
});

test('provider schema subset: terminal_v1 build (10 tools)', () => {
  const tools = buildManagedAgentTools('terminal_v1', 'build');
  assert.equal(tools.length, 10);
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ['run_command', 'terminal_status', 'cancel_command', 'get_workspace_info', 'find_files', 'search_text', 'read_file', 'propose_patch', 'apply_patch', 'undo_change']
  );
  lintTools(tools, 'terminal_v1/build');
  const run = tools.find((t) => t.function.name === 'run_command');
  assert.deepEqual(run.function.parameters.required, ['executable']);
  assert.ok(run.function.description.includes('executable "node"'), 'run_command description carries concrete example');
});

test('provider schema subset: inspect_v1 ask (8) and plan (9)', () => {
  const ask = buildManagedAgentTools('inspect_v1', 'ask');
  assert.deepEqual(
    ask.map((t) => t.function.name),
    ['get_workspace_info', 'list_directory', 'find_files', 'glob', 'search_text', 'grep', 'read_file', 'get_diagnostics']
  );
  lintTools(ask, 'inspect_v1/ask');
  const plan = buildManagedAgentTools('inspect_v1', 'plan');
  assert.deepEqual(
    plan.map((t) => t.function.name),
    ['get_workspace_info', 'list_directory', 'find_files', 'glob', 'search_text', 'grep', 'read_file', 'get_diagnostics', 'propose_patch']
  );
  lintTools(plan, 'inspect_v1/plan');
  const grep = ask.find((t) => t.function.name === 'grep');
  assert.deepEqual(grep.function.parameters.required, ['pattern']);
  const diagnostics = ask.find((t) => t.function.name === 'get_diagnostics');
  assert.ok(diagnostics.function.description.includes('VS Code'), 'descriptions stay explicit about host execution');
});

test('provider schema subset: verify_v1 build (18 tools)', () => {
  const tools = buildManagedAgentTools('verify_v1', 'build');
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ['get_workspace_info', 'list_directory', 'find_files', 'glob', 'search_text', 'grep', 'read_file', 'get_diagnostics',
      'propose_patch', 'apply_patch', 'undo_change',
      'run_command', 'terminal_status', 'cancel_command',
      'run_typecheck', 'run_lint', 'run_build', 'run_tests']
  );
  lintTools(tools, 'verify_v1/build');
  const tests = tools.find((t) => t.function.name === 'run_tests');
  assert.ok(tests.function.description.includes('permission-controlled'), 'run_tests states host execution');
  for (const tool of tools) {
    assert.ok(!tool.function.description.includes('backend runs'), 'backend never claims to execute');
  }
});

test('frozen versions never gain Phase 17 tools', () => {
  const names17 = ['list_directory', 'glob', 'grep', 'get_diagnostics', 'run_typecheck', 'run_lint', 'run_build', 'run_tests'];
  for (const [version, mode] of [['read_v1', 'ask'], ['file_v1', 'plan'], ['file_v2', 'plan'], ['file_v1', 'build'], ['file_v2', 'build'], ['terminal_v1', 'build']]) {
    const names = buildManagedAgentTools(version, mode).map((t) => t.function.name);
    for (const leaked of names17) {
      assert.ok(!names.includes(leaked), `${version}/${mode} must not contain ${leaked}`);
    }
  }
});
