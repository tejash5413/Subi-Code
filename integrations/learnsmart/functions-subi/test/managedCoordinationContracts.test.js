const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../src/services/managedAgentTools');
const { validateAgentBody, agentSystemPrompt } = require('../src/services/managedAgentValidator');
const config = require('../src/services/managedAgentConfigService');
const versions = { agent_jobs_coordination_v1: 'agent_jobs_v1', agent_mcp_coordination_v1: 'agent_mcp_v1', agent_pty_coordination_v1: 'agent_pty_v1' };
const names = ['coordination_submit', 'coordination_get', 'coordination_review', 'coordination_retry'];
const node = (id) => ({ nodeId: id, title: 'Inspect', goal: 'Inspect bounded area', profile: 'explore', scope: { rootId: 'root', files: ['a.ts'], dirs: [], symbols: [] }, dependsOn: [], required: true, acceptanceRefs: ['accept-1'] });
const proposal = () => ({ taskId: 'task', nodes: [node('one'), node('two')] });
function body(version, toolName, args, agentMode = 'plan') {
  return { protocolVersion: 1, modelKey: 'mdl_fixture', agentMode, clientRunId: 'coordination', providerRequestIndex: 0,
    toolCapabilityVersion: version, accountingPeriod: '2026-10', canonicalTurns: [
      { role: 'user', content: 'Investigate independently scoped areas' },
      { role: 'assistantToolCalls', text: '', toolCalls: [{ providerCallId: 'call', toolName, args }] },
      { role: 'toolResult', providerCallId: 'call', toolName, content: '{}', isError: false } ] };
}
for (const [version, base] of Object.entries(versions)) {
  test(version + ' inherits exact base schemas with bounded parent coordination in Plan/Build', () => {
    assert.equal(tools.isCoordinationCapability(version), true);
    for (const mode of ['ask', 'plan', 'build']) {
      const actual = tools.buildManagedAgentTools(version, mode); const legacy = tools.buildManagedAgentTools(base, mode);
      assert.deepEqual(actual.filter(tool => !names.includes(tool.function.name) && tool.function.name !== 'ask_user'), legacy.filter(tool => tool.function.name !== 'ask_user'));
      assert.equal(actual.filter(tool => names.includes(tool.function.name)).length, mode === 'ask' ? 0 : 4);
      assert.equal(legacy.some(tool => names.includes(tool.function.name)), false);
      assert.equal(legacy.find(tool => tool.function.name === 'ask_user').function.parameters.properties.questions.type, 'string');
      assert.equal(actual.find(tool => tool.function.name === 'ask_user').function.parameters.properties.questions.type, 'array');
    }
    assert.equal(validateAgentBody(body(version, 'coordination_submit', proposal())).toolCapabilityVersion, version);
    assert.throws(() => validateAgentBody(body(base, 'coordination_submit', proposal())));
    assert.throws(() => validateAgentBody(body(version, 'coordination_get', { planId: 'plan' }, 'ask')));
    assert.deepEqual(tools.buildManagedAgentTools(version, 'build', { agent: { allowedTools: ['read_file'] } }).map(tool => tool.function.name), ['read_file']);
    assert.ok(agentSystemPrompt('plan', version).includes('coordination_submit'));
    const childPrompt = agentSystemPrompt('build', version, undefined, { agent: { catalogId: 'agent:review', baseProfile: 'review', contentHash: 'a'.repeat(64), instructions: 'Inspect', allowedTools: ['read_file'] } });
    assert.equal(childPrompt.includes('coordination_submit'), false); assert.equal(childPrompt.includes('ask_user'), false);
  });
  test(version + ' rejects injected authority, invalid dependencies, scopes, and oversized proposals', () => {
    for (const change of [p => { p.owner = {}; }, p => { p.nodes[0].hostToken = 'host'; },
      p => { p.nodes[0].scope.owner = {}; }, p => { p.nodes[0].goal = 'x'.repeat(1001); },
      p => { p.nodes = Array.from({ length: 31 }, (_, i) => node('n' + i)); },
      p => { p.nodes[0].dependsOn = ['two']; p.nodes[1].dependsOn = ['one']; },
      p => { p.nodes[0].dependsOn = ['missing']; }, p => { p.nodes[0].scope.files = ['../secret']; },
      p => { p.nodes[0].acceptanceRefs = []; }]) {
      const p = proposal(); change(p); assert.throws(() => validateAgentBody(body(version, 'coordination_submit', p)), e => e.code === 'INVALID_REQUEST');
    }
  });
  test(version + ' negotiates richer questions while preserving old question schema', () => {
    const args = { questions: [{ id: 'q', question: 'Choose the approach', options: [{ id: 'a', label: 'Small change', description: 'Limit the scope' }] }] };
    assert.deepEqual(validateAgentBody(body(version, 'ask_user', args)).canonicalTurns[1].toolCalls[0].args, args);
    assert.throws(() => validateAgentBody(body(base, 'ask_user', args)));
    for (const change of [a => { a.questions[0].owner = {}; }, a => { a.questions[0].options[0].approved = true; },
      a => { a.questions[0].options[0].description = 'x'.repeat(201); }, a => { a.questions[0].question = 'Enter your API key'; },
      a => { a.questions.push(structuredClone(a.questions[0])); }]) {
      const a = structuredClone(args); change(a); assert.throws(() => validateAgentBody(body(version, 'ask_user', a)), e => e.code === 'INVALID_REQUEST');
    }
  });
}
test('coordination advertisement is default-off and requires admitted jobs/account access', () => {
  for (const value of [undefined, false, null, 1, 'true']) assert.equal(config.evaluateCoordinationCapability({ mode: 'enabled', jobsEnabled: true, coordinationEnabled: value }, 'user'), undefined);
  assert.equal(config.evaluateCoordinationCapability({ mode: 'enabled', jobsEnabled: true, coordinationEnabled: true }, 'user'), 'coordination_v1');
  assert.equal(config.evaluateCoordinationCapability({ mode: 'enabled', jobsEnabled: false, coordinationEnabled: true }, 'user'), undefined);
  assert.equal(config.evaluateCoordinationCapability({ mode: 'test', testUids: ['other'], jobsEnabled: true, coordinationEnabled: true }, 'user'), undefined);
});

test('outgoing_coordination_provider_calls_require_projected_schema_before_ready_event', async () => {
  const { streamManagedAgent } = require('../src/services/managedAgentService');
  for (const [toolName, args, mode, valid] of [['coordination_get', { planId: 'plan' }, 'plan', true],
    ['coordination_get', { planId: 'plan', hostToken: 'forbidden' }, 'plan', false],
    ['coordination_submit', proposal(), 'ask', false], ['unknown_tool', {}, 'build', false]]) {
    const events = [];
    const provider = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
    const result = streamManagedAgent({ upstreamModelId: 'fixture', openRouterMessages: [{ role: 'user', content: 'Inspect' }],
      toolCapabilityVersion: 'agent_jobs_coordination_v1', agentMode: mode, maxOutputTokens: 100,
      keyResolver: async () => Buffer.from('fixture-key'), fetchImpl: async () => ({ status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(provider)); controller.close(); } }) }),
      onEvent: async event => { events.push(event); } });
    if (valid) await result;
    else await assert.rejects(result, e => e.code === 'PROVIDER_UNAVAILABLE' && e.providerAccepted === true && e.usage.inputTokens === 5);
    assert.equal(events.some(event => event.type === 'toolCallReady'), valid);
  }
});

test('review_and_retry_commands_bind_all_current_revisions_and_reject_unknown_authority', () => {
  const identity = { planId: 'plan', expectedRevision: 1, planRevision: 1, nodeId: 'node', jobId: 'job', attemptId: 'attempt', jobRevision: 1 };
  for (const version of Object.keys(versions)) {
    assert.ok(validateAgentBody(body(version, 'coordination_review', { ...identity, decision: 'accept', reason: '' })));
    assert.ok(validateAgentBody(body(version, 'coordination_retry', { ...identity, profile: 'debug', customRoleId: 'role' })));
    for (const name of ['coordination_review', 'coordination_retry']) {
      const args = name === 'coordination_review' ? { ...identity, decision: 'reject', reason: 'failed' } : identity;
      for (const field of Object.keys(identity)) { const missing = { ...args }; delete missing[field]; assert.throws(() => validateAgentBody(body(version, name, missing))); }
      assert.throws(() => validateAgentBody(body(version, name, { ...args, approved: true })));
      assert.throws(() => validateAgentBody(body(version, name, { ...args, jobRevision: -1 })));
    }
  }
});
