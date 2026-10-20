const test = require('node:test');
const assert = require('node:assert/strict');
const { buildManagedAgentTools } = require('../src/services/managedAgentTools');
const { validateAgentBody, agentSystemPrompt } = require('../src/services/managedAgentValidator');
const context = { agent: { catalogId: 'agent-opaque', baseProfile: 'review', instructions: 'Review correctness.', contentHash: 'a'.repeat(64) }, skills: [{ catalogId: 'skill-opaque', instructions: 'Inspect before acting.' }] };
function body(version = 'agent_skills_v1', toolName, args = {}, extra = {}) {
  return { protocolVersion: 1, modelKey: 'mdl_a', agentMode: 'plan', clientRunId: 'run-contract', providerRequestIndex: 0,
    toolCapabilityVersion: version, canonicalTurns: toolName ? [
      { role: 'user', content: 'inspect' },
      { role: 'assistantToolCalls', text: '', toolCalls: [{ providerCallId: 'c1', toolName, args }] },
      { role: 'toolResult', providerCallId: 'c1', toolName, content: 'ok', isError: false },
    ] : [{ role: 'user', content: 'inspect' }], ...extra };
}
test('new family preserves every existing v3 schema except explicitly negotiated selectors', () => {
  for (const mode of ['ask', 'plan', 'build']) {
    const old = buildManagedAgentTools('agent_v3', mode);
    const fresh = buildManagedAgentTools('agent_skills_v1', mode);
    for (const t of old.filter(t => !['load_skill', 'delegate_task'].includes(t.function.name))) {
      assert.deepEqual(fresh.find(n => n.function.name === t.function.name), t);
    }
    const skill = fresh.find(t => t.function.name === 'load_skill').function.parameters;
    assert.deepEqual(skill.required, []);
    assert.deepEqual(Object.keys(skill.properties), ['name', 'catalogId']);
    const resource = fresh.find(t => t.function.name === 'load_skill_resource').function.parameters;
    assert.deepEqual(resource.required, ['catalogId', 'relativePath']);
    assert.equal(resource.additionalProperties, false);
    const task = fresh.find(t => t.function.name === 'delegate_task');
    if (mode === 'ask') assert.equal(task, undefined);
    else { assert.deepEqual(task.function.parameters.required, ['task']); assert.ok(task.function.parameters.properties.agentCatalogId); }
  }
});
test('selectors and resources require explicit negotiated family', () => {
  for (const version of ['agent_v2', 'agent_v3']) {
    assert.throws(() => validateAgentBody(body(version, 'load_skill', { catalogId: 'opaque' })), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateAgentBody(body(version, 'delegate_task', { task: 'inspect', agentCatalogId: 'opaque' })), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateAgentBody(body(version, 'load_skill_resource', { catalogId: 'opaque', relativePath: 'guide.md' })), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateAgentBody(body(version, undefined, {}, { agentSkillsContext: context })), { code: 'INVALID_REQUEST' });
  }
  for (const [tool, args] of [['load_skill', { catalogId: 'opaque' }], ['load_skill', { name: 'review' }], ['delegate_task', { task: 'inspect', agentCatalogId: 'opaque' }], ['load_skill_resource', { catalogId: 'opaque', relativePath: 'guide.md' }]]) {
    assert.deepEqual(validateAgentBody(body('agent_skills_v1', tool, args)).canonicalTurns[1].toolCalls[0].args, args);
  }
});
test('selected context is closed, bounded UTF8 data and explicitly subordinate', () => {
  const accepted = validateAgentBody(body('agent_skills_v1', undefined, {}, { agentSkillsContext: context }));
  assert.deepEqual(accepted.agentSkillsContext, context);
  const prompt = agentSystemPrompt('plan', 'agent_skills_v1', undefined, accepted.agentSkillsContext);
  assert.ok(prompt.includes('Review correctness.'));
  assert.ok(prompt.includes('subordinate'));
  for (const bad of [
    { ...context, accountType: 'individual' },
    { agent: { ...context.agent, modelKey: 'mdl_other' } },
    { agent: { ...context.agent, baseProfile: 'admin' } },
    { agent: { ...context.agent, instructions: '界'.repeat(2800) } },
    { skills: [{ catalogId: 'opaque', instructions: '界'.repeat(11000) }] },
    { skills: new Array(9).fill(context.skills[0]) },
    { skills: [1, 2, 3].map(n => ({ catalogId: `s-${n}`, instructions: 'x'.repeat(24000) })) },
  ]) assert.throws(() => validateAgentBody(body('agent_skills_v1', undefined, {}, { agentSkillsContext: bad })), e => ['INVALID_REQUEST', 'REQUEST_TOO_LARGE'].includes(e.code));
  for (const args of [{}, { name: 'review', catalogId: 'opaque' }, { catalogId: '../escape' }, { catalogId: 'x'.repeat(201) }]) {
    assert.throws(() => validateAgentBody(body('agent_skills_v1', 'load_skill', args)), e => ['INVALID_REQUEST', 'REQUEST_TOO_LARGE'].includes(e.code));
  }
  for (const relativePath of ['../secret', '/absolute', 'C:\\secret', 'a/../secret']) {
    assert.throws(() => validateAgentBody(body('agent_skills_v1', 'load_skill_resource', { catalogId: 'opaque', relativePath })), { code: 'INVALID_REQUEST' });
  }
});

test('selected read-role tool list only narrows negotiated schemas and prompt', () => {
  const selected = { agent: { ...context.agent, allowedTools: ['read_file', 'get_diagnostics', 'unknown_tool'] } };
  const validated = validateAgentBody(body('agent_skills_v1', undefined, {}, { agentSkillsContext: selected }));
  const tools = buildManagedAgentTools('agent_skills_v1', 'plan', validated.agentSkillsContext);
  assert.deepEqual(tools.map(t => t.function.name), ['read_file', 'get_diagnostics']);
  for (const name of ['load_skill', 'load_skill_resource', 'apply_patch', 'run_command', 'delegate_task', 'unknown_tool']) assert.equal(tools.some(t => t.function.name === name), false);
  assert.deepEqual(buildManagedAgentTools('agent_skills_v1', 'plan', { agent: { ...context.agent, allowedTools: [] } }), []);
  assert.deepEqual(buildManagedAgentTools('agent_v3', 'plan', selected), buildManagedAgentTools('agent_v3', 'plan'));
  const prompt = agentSystemPrompt('plan', 'agent_skills_v1', undefined, validated.agentSkillsContext);
  assert.ok(prompt.includes('Available tools: read_file, get_diagnostics.'));
  for (const promised of ['load_skill_resource reads', 'delegate reads with', 'propose with propose_patch', 'project_overview for']) assert.equal(prompt.includes(promised), false);
  const history = validateAgentBody(body('agent_skills_v1', 'load_skill', { name: 'review' }, { agentSkillsContext: selected }));
  assert.equal(history.canonicalTurns[1].toolCalls[0].toolName, 'load_skill', 'historical results remain readable, never current tool authority');
});

test('restrictive role tool list rejects malformed duplicate and oversized shapes', () => {
  for (const allowedTools of [['read_file', 'read_file'], ['../escape'], 'read_file', new Array(101).fill('read_file'), ['Atool']]) {
    assert.throws(() => validateAgentBody(body('agent_skills_v1', undefined, {}, { agentSkillsContext: { agent: { ...context.agent, allowedTools } } })), { code: 'INVALID_REQUEST' });
  }
});
