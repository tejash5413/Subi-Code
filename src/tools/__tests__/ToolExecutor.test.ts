import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../ToolRegistry';
import { ToolExecutor } from '../ToolExecutor';
import { ToolActivity, ToolError, ToolDefinition } from '../ToolTypes';

function echoTool(name: string, payload: Record<string, unknown> = { hello: 'world' }): ToolDefinition {
  return {
    metadata: {
      name,
      description: name,
      category: 'workspace',
      permission: 'read',
      availableInModes: ['ask', 'plan'],
      inputSchema: [],
      displayLabel: name,
      locked: false,
    },
    async execute() {
      return payload;
    },
  };
}

function capture(): { events: ToolActivity[]; push(e: ToolActivity): void } {
  const events: ToolActivity[] = [];
  return { events, push: (e) => events.push(e) };
}

void test('execute a known tool returns success envelope and emits events', async () => {
  const reg = new ToolRegistry();
  reg.register(echoTool('echo', { value: 42 }));
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'echo', args: {} }, 'ask');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.callId, 'c1');
    assert.equal(result.toolName, 'echo');
    assert.equal(result.summary, 'Done.');
    assert.deepEqual(result.payload, { value: 42 });
  }
  // Two events: started, completed
  assert.equal(cap.events.length, 2);
  assert.equal(cap.events[0].type, 'toolStarted');
  assert.equal(cap.events[1].type, 'toolCompleted');
});

void test('execute unknown tool returns TOOL_NOT_FOUND', async () => {
  const reg = new ToolRegistry();
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'missing', args: {} }, 'ask');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'TOOL_NOT_FOUND');
  }
  // Unknown tools short-circuit before the activity emitter.
  assert.equal(cap.events.length, 0);
});

void test('mode denied returns TOOL_NOT_ALLOWED', async () => {
  const reg = new ToolRegistry();
  reg.register({
    metadata: {
      name: 'buildonly',
      description: 'b',
      category: 'workspace',
      permission: 'read',
      availableInModes: ['build'],
      inputSchema: [],
      locked: false,
    },
    async execute() {
      return null;
    },
  });
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'buildonly', args: {} }, 'ask');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'TOOL_NOT_ALLOWED');
  }
});

void test('invalid args returns TOOL_INVALID_ARGUMENTS', async () => {
  const reg = new ToolRegistry();
  reg.register({
    metadata: {
      name: 'greet',
      description: 'g',
      category: 'workspace',
      permission: 'read',
      availableInModes: ['ask'],
      inputSchema: [{ name: 'name', type: 'string', required: true, description: 'name' }],
      locked: false,
    },
    async execute() {
      return 'hi';
    },
  });
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'greet', args: {} }, 'ask');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'TOOL_INVALID_ARGUMENTS');
    assert.match(result.message, /name/);
  }
});

void test('tool execution error maps to INTERNAL', async () => {
  const reg = new ToolRegistry();
  reg.register({
    metadata: {
      name: 'boom',
      description: 'b',
      category: 'workspace',
      permission: 'read',
      availableInModes: ['ask'],
      inputSchema: [],
      locked: false,
    },
    async execute() {
      throw new Error('explosion');
    },
  });
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'boom', args: {} }, 'ask');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INTERNAL');
  }
});

void test('ToolError thrown by tool maps to its code', async () => {
  const reg = new ToolRegistry();
  reg.register({
    metadata: {
      name: 'throw-special',
      description: 'b',
      category: 'files',
      permission: 'read',
      availableInModes: ['ask'],
      inputSchema: [],
      locked: false,
    },
    async execute() {
      throw new ToolError('FILE_NOT_FOUND', 'No such file.', 'throw-special');
    },
  });
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'throw-special', args: {} }, 'ask');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'FILE_NOT_FOUND');
  }
});

void test('cancel is a no-op when idle', () => {
  const reg = new ToolRegistry();
  reg.register(echoTool('echo'));
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  ex.cancel();
  assert.equal(ex.isActive(), false);
});

void test('summary is computed for known tools', async () => {
  const reg = new ToolRegistry();
  reg.register(echoTool('get_workspace_info', { name: 'demo', projectType: 'node' }));
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'get_workspace_info', args: {} }, 'ask');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.summary, /demo/);
    assert.match(result.summary, /node/);
  }
});

void test('summary for find_files reflects count', async () => {
  const reg = new ToolRegistry();
  reg.register(echoTool('find_files', { count: 3, items: [], truncated: false }));
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'find_files', args: {} }, 'ask');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.summary, '3 files');
  }
});

void test('summary for read_file reflects path and size', async () => {
  const reg = new ToolRegistry();
  reg.register(echoTool('read_file', { displayPath: 'src/index.ts', size: 1024, content: 'x', truncated: false }));
  const cap = capture();
  const ex = new ToolExecutor(reg, cap.push);
  const result = await ex.execute({ callId: 'c1', toolName: 'read_file', args: {} }, 'ask');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.summary, /src\/index\.ts/);
    assert.match(result.summary, /1024/);
  }
});
