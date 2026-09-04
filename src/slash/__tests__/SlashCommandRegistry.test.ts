import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandRegistry } from '../SlashCommandRegistry';
import { createDefaultSlashCommands } from '../createDefaultSlashCommands';

void test('register and get by name', () => {
  const reg = new SlashCommandRegistry();
  for (const c of createDefaultSlashCommands()) {
    reg.register(c);
  }
  const cmd = reg.get('/ask');
  assert.ok(cmd);
  assert.equal(cmd.name, '/ask');
});

void test('register and get by alias', () => {
  const reg = new SlashCommandRegistry();
  reg.register({ name: '/foo', description: 'x', category: 'session', available: true, aliases: ['/f'] });
  const cmd = reg.get('/f');
  assert.ok(cmd);
  assert.equal(cmd.name, '/foo');
});

void test('rejects duplicate primary name', () => {
  const reg = new SlashCommandRegistry();
  reg.register({ name: '/foo', description: 'x', category: 'session', available: true });
  assert.throws(() => reg.register({ name: '/foo', description: 'y', category: 'session', available: true }));
});

void test('rejects duplicate alias', () => {
  const reg = new SlashCommandRegistry();
  reg.register({ name: '/foo', description: 'x', category: 'session', available: true, aliases: ['/f'] });
  assert.throws(() => reg.register({ name: '/bar', description: 'y', category: 'session', available: true, aliases: ['/f'] }));
});

void test('rejects invalid name (no leading slash)', () => {
  const reg = new SlashCommandRegistry();
  assert.throws(() => reg.register({ name: 'foo', description: 'x', category: 'session', available: true }));
});

void test('rejects invalid alias (no leading slash)', () => {
  const reg = new SlashCommandRegistry();
  assert.throws(() => reg.register({ name: '/foo', description: 'x', category: 'session', available: true, aliases: ['f'] }));
});

void test('list returns distinct commands sorted by name', () => {
  const reg = new SlashCommandRegistry();
  for (const c of createDefaultSlashCommands()) {
    reg.register(c);
  }
  const all = reg.list();
  const names = all.map((c) => c.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted);
  // No duplicate names
  assert.equal(new Set(names).size, names.length);
});

void test('filter is case-insensitive substring on name/alias/description', () => {
  const reg = new SlashCommandRegistry();
  for (const c of createDefaultSlashCommands()) {
    reg.register(c);
  }
  const matches1 = reg.filter('sear');
  assert.ok(matches1.some((m) => m.name === '/search'));
  const matches2 = reg.filter('clear');
  assert.ok(matches2.some((m) => m.name === '/clear'));
  const matches3 = reg.filter('workspace');
  // /context mentions workspace in its description.
  assert.ok(matches3.some((m) => m.name === '/context'));
});

void test('empty filter returns all distinct commands', () => {
  const reg = new SlashCommandRegistry();
  for (const c of createDefaultSlashCommands()) {
    reg.register(c);
  }
  const all = reg.list();
  assert.equal(reg.filter('').length, all.length);
});

void test('default registry contains available and locked commands', () => {
  const reg = new SlashCommandRegistry();
  for (const c of createDefaultSlashCommands()) {
    reg.register(c);
  }
  const available = reg.list().filter((c) => c.available);
  const locked = reg.list().filter((c) => !c.available);
  assert.ok(available.length > 0);
  assert.ok(locked.length > 0);
  // /ask and /plan are available; /build is locked
  assert.ok(available.some((c) => c.name === '/ask'));
  assert.ok(available.some((c) => c.name === '/plan'));
  assert.ok(locked.some((c) => c.name === '/build'));
});
