const test = require('node:test');
const assert = require('node:assert/strict');
const { buildManagedAgentTools } = require('../src/services/managedAgentTools');
const { validateAgentBody } = require('../src/services/managedAgentValidator');
const { evaluateTerminalCapability } = require('../src/services/managedAgentConfigService');

function body(args, capability = 'terminal_v1', mode = 'build') {
  return { protocolVersion: 1, modelKey: 'mdl_a', agentMode: mode,
    clientRunId: 'test-run', providerRequestIndex: 1, toolCapabilityVersion: capability,
    canonicalTurns: [{ role: 'user', content: 'Check the project.' },
      { role: 'assistantToolCalls', text: '', toolCalls: [{ providerCallId: 'c1', toolName: 'run_command', args }] },
      { role: 'toolResult', providerCallId: 'c1', toolName: 'run_command', content: 'completed', isError: false }] };
}
test('terminal contract adds exactly three tools to Build and preserves file contracts', () => {
  assert.equal(buildManagedAgentTools('read_v1', 'ask').length, 4);
  assert.equal(buildManagedAgentTools('file_v2', 'plan').length, 5);
  assert.equal(buildManagedAgentTools('file_v2', 'build').length, 7);
  const tools = buildManagedAgentTools('terminal_v1', 'build');
  assert.equal(tools.length, 10);
  const command = tools.find(t => t.function.name === 'run_command').function.parameters;
  assert.equal(command.additionalProperties, false);
  assert.equal(command.properties.args.type, 'array');
  assert.equal(command.properties.args.items.type, 'string');
  assert.equal(command.properties.timeoutMs.type, 'integer');
  assert.deepEqual(command.required, ['executable']);
});
test('terminal availability requires explicit gate, test mode, and listed identity', () => {
  for (const mode of ['disabled', 'enabled', 'test']) for (const terminalEnabled of [false, true]) {
    const config = { mode, terminalEnabled, testUids: ['test-user'] };
    assert.equal(evaluateTerminalCapability(config, 'other-user'), 'none');
    assert.equal(evaluateTerminalCapability(config, 'test-user'), mode === 'test' && terminalEnabled ? 'terminal' : 'none');
  }
  assert.equal(evaluateTerminalCapability(null, 'test-user'), 'none');
});
test('terminal argv survives validation without coercion and cannot enter old contracts', () => {
  const args = { executable: 'npm', args: ['run', 'build'], cwd: '.', timeoutMs: 120000, executionMode: 'foreground' };
  assert.doesNotThrow(() => validateAgentBody(body(args)));
  for (const cap of ['file_v1', 'file_v2', 'read_v1']) assert.throws(() => validateAgentBody(body(args, cap)));
  for (const mode of ['ask', 'plan']) assert.throws(() => validateAgentBody(body(args, 'terminal_v1', mode)));
});
test('terminal protocol rejects authority injection, nested argv, and malformed bounds', () => {
  for (const args of [
    { executable: 'node', command: 'node --version' },
    { executable: 'node', env: {} }, { executable: 'node', approved: true },
    { executable: 'node', args: ['--version', {}] }, { executable: 'node', args: '--version' },
    { executable: 'node', timeoutMs: '120' }, { executable: 'node', timeoutMs: 1.5 },
    { executable: 'node', timeoutMs: -1 }, { executable: 'node', executionMode: 'shell' },
    { executable: 'node', args: Array(129).fill('a') },
  ]) assert.throws(() => validateAgentBody(body(args)));
});

test('17A freeze: inspect_v1/verify_v1 mode matrix (schemas pending)', () => {
  const turn = (capability, mode) => ({
    protocolVersion: 1, modelKey: 'mdl_a', agentMode: mode,
    clientRunId: 'test-run', providerRequestIndex: 0, toolCapabilityVersion: capability,
    canonicalTurns: [{ role: 'user', content: 'hi' }],
  });
  for (const pair of [['inspect_v1', 'ask'], ['inspect_v1', 'plan'], ['verify_v1', 'build']]) {
    validateAgentBody(turn(pair[0], pair[1]));
  }
  for (const pair of [['inspect_v1', 'build'], ['verify_v1', 'ask'], ['verify_v1', 'plan']]) {
    assert.throws(() => validateAgentBody(turn(pair[0], pair[1])));
  }
  assert.throws(() => validateAgentBody(turn('inspect_v2', 'ask')));
});
