const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAgentBody } = require('../src/services/managedAgentValidator');

function request(over = {}) {
  return {
    protocolVersion: 1, modelKey: 'mdl_native', agentMode: 'build',
    clientRunId: 'native_request_1', providerRequestIndex: 0,
    toolCapabilityVersion: 'agent_v3',
    nativeRequest: { messages: [{ role: 'user', content: 'Fix the test.' }], tools: [{ type: 'function', function: { name: 'bash', description: 'Run a local command subject to host approval.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }] },
    ...over,
  };
}

test('native requests accept bounded native tool schemas without granting execution authority', () => {
  const body = request();
  const parsed = validateAgentBody(body);
  assert.deepEqual(parsed.nativeRequest.tools, body.nativeRequest.tools);
  assert.equal(parsed.nativeRequest.messages[0].content, 'Fix the test.');
  assert.equal(parsed.toolCapabilityVersion, 'agent_v3');
});

test('native validation rejects key, route, authority and legacy history overrides', () => {
  for (const extra of [{ apiKey: 'sentinel' }, { accountType: 'individual' }, { canonicalTurns: [] }, { nativeRequest: { ...request().nativeRequest, model: 'upstream/model' } }]) {
    assert.throws(() => validateAgentBody(request(extra)), { code: 'INVALID_REQUEST' });
  }
});

test('native history preserves tool call relationships and rejects orphan/duplicate calls', () => {
  const body = request();
  body.nativeRequest.messages.push(
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'one test failed' },
  );
  assert.equal(validateAgentBody(body).nativeRequest.messages[2].tool_call_id, 'call_1');
  body.nativeRequest.messages[2].tool_call_id = 'orphan';
  assert.throws(() => validateAgentBody(body), { code: 'INVALID_REQUEST' });
  body.nativeRequest.messages[2].tool_call_id = 'call_1';
  body.nativeRequest.messages.push(body.nativeRequest.messages[1]);
  assert.throws(() => validateAgentBody(body), { code: 'INVALID_REQUEST' });
});

test('native contract enforces resource limits and requires tools to have an object schema', () => {
  const huge = request();
  huge.nativeRequest.messages[0].content = 'x'.repeat(1_000_001);
  assert.throws(() => validateAgentBody(huge), { code: 'REQUEST_TOO_LARGE' });
  const bad = request();
  bad.nativeRequest.tools[0].function.parameters = { type: 'string' };
  assert.throws(() => validateAgentBody(bad), { code: 'INVALID_REQUEST' });
});

test('native ASK/PLAN cannot advertise direct mutation or terminal tools', () => {
  for (const agentMode of ['ask', 'plan']) assert.throws(() => validateAgentBody(request({ agentMode })), { code: 'INVALID_REQUEST' });
  const body = request({ agentMode: 'plan' });
  body.toolCapabilityVersion = 'inspect_v1';
  body.nativeRequest.tools[0].function.name = 'read';
  assert.equal(validateAgentBody(body).agentMode, 'plan');
});

test('native stream withholds executable calls until settlement and discards them on error', () => {
  const { stream } = require('../src/services/managedNativeAgent');
  const output = [];
  const write = stream({ write: value => output.push(value) }, 'mdl_native');
  write('toolCallReady', { providerCallId: 'call_1', toolName: 'bash', argsText: '{"command":"npm test"}' });
  assert.deepEqual(output, []);
  write('error', { code: 'ACCOUNTING_UNAVAILABLE' });
  assert.ok(!output.join('').includes('tool_calls'));
  assert.match(output.join(''), /ACCOUNTING_UNAVAILABLE/);
});

for (const withDeltas of [false, true]) test(`native completed calls keep positions and do not append duplicate fields (preceding deltas: ${withDeltas})`, async () => {
  const { streamManagedAgent } = require('../src/services/managedAgentService');
  const nativeRequest = request().nativeRequest;
  const tools = [
    { id: 'call_read', type: 'function', function: { name: 'bash', arguments: '{"command":"node --version"}' } },
    { id: 'call_check', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } },
  ];
  const events = [];
  const body = new ReadableStream({ start(controller) {
    if (withDeltas) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: tools.map((tool, index) => ({ ...tool, index })) } }] }) + '\n\n'));
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ message: { content: null, tool_calls: tools }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n'));
    controller.close();
  } });
  const result = await streamManagedAgent({
    upstreamModelId: 'fixture/model', openRouterMessages: nativeRequest.messages,
    nativeRequest, agentMode: 'build', toolCapabilityVersion: 'agent_v3',
    keyResolver: async () => Buffer.from('fixture-key'), fetchImpl: async () => ({ status: 200, body }),
    onEvent: async event => events.push(event),
  });
  assert.deepEqual(result.toolCalls, tools.map(tool => ({ providerCallId: tool.id, toolName: tool.function.name, argsText: tool.function.arguments })));
  assert.equal(events.filter(event => event.type === 'toolCallReady').length, 2);
  assert.equal(result.inputTokens, 20);
});

test('provider stream error diagnostics keep numeric status but never raw provider details', async () => {
  const { streamManagedAgent } = require('../src/services/managedAgentService');
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"error":{"code":503,"message":"private-provider-sentinel"}}\n\n'));
    controller.close();
  } });
  await assert.rejects(streamManagedAgent({
    upstreamModelId: 'fixture/model', openRouterMessages: request().nativeRequest.messages,
    keyResolver: async () => Buffer.from('fixture-key'), fetchImpl: async () => ({ status: 200, body }), onEvent: async () => {},
  }), error => error.code === 'PROVIDER_UNAVAILABLE' && error.httpStatus === 503 && error.failureKind === 'provider_event_error' && !JSON.stringify(error).includes('private-provider-sentinel'));
});

test('native errors show an actionable safe category without copying provider details', () => {
  const { stream } = require('../src/services/managedNativeAgent');
  for (const code of ['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'ACCOUNTING_UNAVAILABLE', 'untrusted-secret-sentinel']) {
    const output = [];
    stream({ write: value => output.push(value) }, 'mdl_native', false)('error', { code, message: 'provider-secret-sentinel' });
    const error = JSON.parse(output.join('')).error;
    assert.ok(error.message.includes(code === 'untrusted-secret-sentinel' ? 'INTERNAL' : code));
    assert.ok(!output.join('').includes('secret-sentinel'));
  }
});
