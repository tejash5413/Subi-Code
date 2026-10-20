const test = require('node:test');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
const { buildManagedAgentTools } = require(root + '/src/services/managedAgentTools');
const { validateAgentBody } = require(root + '/src/services/managedAgentValidator');
for (const version of ['agent_mcp_skills_v1', 'agent_mcp_v1']) test(version + ' preserves the base and validates fixed host MCP calls', () => {
  const base = version === 'agent_mcp_v1' ? 'agent_jobs_v1' : 'agent_skills_v1';
  const names = buildManagedAgentTools(version, 'plan').map(tool => tool.function.name);
  assert.deepEqual(names.filter(name => !name.startsWith('mcp_')), buildManagedAgentTools(base, 'plan').map(tool => tool.function.name));
  assert.equal(names.filter(name => name.startsWith('mcp_')).length, 6);
  assert.equal(buildManagedAgentTools(base, 'plan').some(tool => tool.function.name.startsWith('mcp_')), false);
  const request = { protocolVersion: 1, modelKey: 'mdl_fixture', agentMode: 'plan', clientRunId: 'fixture', providerRequestIndex: 0,
    toolCapabilityVersion: version, ...(version === 'agent_mcp_v1' ? { accountingPeriod: '2026-10' } : {}),
    canonicalTurns: [{ role: 'user', content: 'Read connected MCP data' }, { role: 'assistantToolCalls', text: '',
      toolCalls: [{ providerCallId: 'call', toolName: 'mcp_read_tool', args: { toolId: 'mcp__fixture__echo', argumentsJson: '{"text":"hello"}' } }] },
      { role: 'toolResult', providerCallId: 'call', toolName: 'mcp_read_tool', content: 'hello', isError: false }] };
  assert.equal(validateAgentBody(request).toolCapabilityVersion, version);
  for (const args of [{ toolId: 'mcp__fixture__echo', argumentsJson: '[]' }, { toolId: 'mcp__fixture__echo', argumentsJson: '{"__proto__":{}}' },
    { toolId: 'mcp__fixture__echo', argumentsJson: '{}', approved: true }]) {
    const changed = structuredClone(request); changed.canonicalTurns[1].toolCalls[0].args = args;
    assert.throws(() => validateAgentBody(changed), e => e.code === 'INVALID_REQUEST');
  }
  const wrong = { ...request, toolCapabilityVersion: base };
  assert.throws(() => validateAgentBody(wrong), e => e.code === 'INVALID_REQUEST');
});
