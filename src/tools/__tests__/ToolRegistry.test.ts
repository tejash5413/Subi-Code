import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../ToolRegistry';
import { ToolError, ToolDefinition } from '../ToolTypes';

function noopTool(name: string, category: ToolDefinition['metadata']['category'], modes: ReadonlyArray<ToolDefinition['metadata']['availableInModes'][number]> = ['ask', 'plan']): ToolDefinition {
  return {
    metadata: {
      name,
      description: `noop ${name}`,
      category,
      permission: 'read',
      availableInModes: modes,
      inputSchema: [],
      displayLabel: name,
      locked: false,
    },
    async execute() {
      return { ok: true };
    },
  };
}

void test('register and get a tool by name', () => {
  const reg = new ToolRegistry();
  reg.register(noopTool('foo', 'workspace'));
  assert.ok(reg.has('foo'));
  assert.equal(reg.get('foo')?.metadata.name, 'foo');
});

void test('register rejects duplicates', () => {
  const reg = new ToolRegistry();
  reg.register(noopTool('foo', 'workspace'));
  assert.throws(() => reg.register(noopTool('foo', 'workspace')), ToolError);
});

void test('register rejects missing name', () => {
  const reg = new ToolRegistry();
  assert.throws(() => reg.register({ metadata: { name: '', description: 'x', category: 'workspace', permission: 'read', availableInModes: ['ask'], inputSchema: [], locked: false }, execute: async () => undefined }));
});

void test('listMetadata returns sorted, defensive copy', () => {
  const reg = new ToolRegistry();
  reg.register(noopTool('zeta', 'workspace'));
  reg.register(noopTool('alpha', 'files'));
  const list = reg.listMetadata();
  assert.equal(list[0].name, 'alpha');
  assert.equal(list[1].name, 'zeta');
  // Defensive copy: list items must be different object references from
  // the internal registry objects (verified by reference comparison).
  assert.notStrictEqual(list[0], reg.get('alpha')?.metadata);
  assert.notStrictEqual(list[1], reg.get('zeta')?.metadata);
  // Mutating a returned item must not affect registry.
  const originalDesc = reg.get('alpha')?.metadata.description;
  list[0].description = 'mutated';
  assert.equal(reg.get('alpha')?.metadata.description, originalDesc);
});

void test('listByCategory filters', () => {
  const reg = new ToolRegistry();
  reg.register(noopTool('a', 'workspace'));
  reg.register(noopTool('b', 'files'));
  reg.register(noopTool('c', 'workspace'));
  const ws = reg.listByCategory('workspace');
  assert.equal(ws.length, 2);
  assert.ok(ws.every((m) => m.category === 'workspace'));
});

void test('listForMode filters by mode and excludes locked', () => {
  const reg = new ToolRegistry();
  reg.register(noopTool('askonly', 'workspace', ['ask']));
  reg.register(noopTool('planask', 'workspace', ['ask', 'plan']));
  reg.register(noopTool('buildonly', 'workspace', ['build']));
  reg.register({
    metadata: {
      name: 'locked',
      description: 'locked',
      category: 'workspace',
      permission: 'read',
      availableInModes: ['ask', 'plan'],
      inputSchema: [],
      locked: true,
    },
    async execute() {
      return undefined;
    },
  });
  const askList = reg.listForMode('ask');
  assert.ok(askList.some((m) => m.name === 'askonly'));
  assert.ok(askList.some((m) => m.name === 'planask'));
  assert.ok(!askList.some((m) => m.name === 'buildonly'));
  assert.ok(!askList.some((m) => m.name === 'locked'));
  const buildList = reg.listForMode('build');
  assert.ok(buildList.some((m) => m.name === 'buildonly'));
});

void test('resolveForInvocation: unknown tool', () => {
  const reg = new ToolRegistry();
  try {
    reg.resolveForInvocation('missing', 'ask');
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'TOOL_NOT_FOUND');
  }
});

void test('resolveForInvocation: locked tool', () => {
  const reg = new ToolRegistry();
  reg.register({
    metadata: {
      name: 'locked',
      description: 'locked',
      category: 'workspace',
      permission: 'read',
      availableInModes: ['ask'],
      inputSchema: [],
      locked: true,
      lockedReason: 'Test lock',
    },
    async execute() {
      return undefined;
    },
  });
  try {
    reg.resolveForInvocation('locked', 'ask');
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'TOOL_LOCKED');
  }
});

void test('resolveForInvocation: mode not allowed', () => {
  const reg = new ToolRegistry();
  reg.register(noopTool('buildonly', 'workspace', ['build']));
  try {
    reg.resolveForInvocation('buildonly', 'ask');
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'TOOL_NOT_ALLOWED');
  }
});

void test('resolveForInvocation: success', () => {
  const reg = new ToolRegistry();
  reg.register(noopTool('foo', 'workspace', ['ask']));
  const tool = reg.resolveForInvocation('foo', 'ask');
  assert.equal(tool.metadata.name, 'foo');
});
