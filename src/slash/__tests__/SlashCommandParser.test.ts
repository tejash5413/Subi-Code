import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlashInput, splitSlashPrefix } from '../SlashCommandParser';

void test('parseSlashInput: leading slash with name', () => {
  const r = parseSlashInput('/search foo bar');
  assert.equal(r.isCommand, true);
  assert.equal(r.name, '/search');
  assert.equal(r.argument, 'foo bar');
});

void test('parseSlashInput: only name', () => {
  const r = parseSlashInput('/help');
  assert.equal(r.isCommand, true);
  assert.equal(r.name, '/help');
  assert.equal(r.argument, '');
});

void test('parseSlashInput: empty input', () => {
  const r = parseSlashInput('');
  assert.equal(r.isCommand, false);
});

void test('parseSlashInput: non-slash input is not a command', () => {
  const r = parseSlashInput('What does / mean in JavaScript?');
  assert.equal(r.isCommand, false);
});

void test('parseSlashInput: embedded slash without leading slash is not a command', () => {
  const r = parseSlashInput('  /search foo');
  assert.equal(r.isCommand, false);
});

void test('parseSlashInput: escaped leading slash is not a command', () => {
  const r = parseSlashInput('//not a command');
  assert.equal(r.isCommand, false);
});

void test('parseSlashInput: lone slash is not a command', () => {
  assert.equal(parseSlashInput('/').isCommand, false);
  assert.equal(parseSlashInput('/ ').isCommand, false);
});

void test('parseSlashInput: slash with no letters is not a command', () => {
  assert.equal(parseSlashInput('/123').isCommand, false);
  assert.equal(parseSlashInput('/_').isCommand, false);
});

void test('parseSlashInput: multi-line input is chat, not a command', () => {
  const r = parseSlashInput('/search\nfoo');
  assert.equal(r.isCommand, false);
});

void test('parseSlashInput: hyphenated names', () => {
  const r = parseSlashInput('/read-file path/to/x');
  assert.equal(r.isCommand, true);
  assert.equal(r.name, '/read-file');
  assert.equal(r.argument, 'path/to/x');
});

void test('parseSlashInput: argument with leading whitespace is trimmed', () => {
  const r = parseSlashInput('/search    hello world   ');
  assert.equal(r.argument, 'hello world');
});

void test('splitSlashPrefix: returns prefix and rest when present', () => {
  const s = splitSlashPrefix('/search foo bar');
  assert.deepEqual(s, { prefix: '/search', rest: 'foo bar' });
});

void test('splitSlashPrefix: returns prefix only when no space', () => {
  const s = splitSlashPrefix('/help');
  assert.deepEqual(s, { prefix: '/help', rest: '' });
});

void test('splitSlashPrefix: returns null for non-commands', () => {
  assert.equal(splitSlashPrefix('hello world'), null);
  assert.equal(splitSlashPrefix('//escape'), null);
});
