import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedChatHistory } from '../managedChatHistory';

void test('push/getMessages round-trips defensive copies', () => {
  const history = new ManagedChatHistory();
  history.push('user', 'hello');
  history.push('assistant', 'hi');
  assert.equal(history.size, 2);
  const messages = history.getMessages();
  assert.deepEqual(messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  messages[0].content = 'mutated';
  assert.equal(history.getMessages()[0].content, 'hello');
});

void test('invalid pushes ignored', () => {
  const history = new ManagedChatHistory();
  history.push('system' as 'user', 'x');
  history.push('user', '');
  assert.equal(history.size, 0);
});

void test('history trims oldest-first within budgets', () => {
  const history = new ManagedChatHistory();
  for (let i = 0; i < 25; i++) {
    history.push('user', `m${i}`);
  }
  assert.equal(history.size, 20);
  assert.equal(history.getMessages()[0].content, 'm5');
});

void test('histories are independent instances', () => {
  const a = new ManagedChatHistory();
  const b = new ManagedChatHistory();
  a.push('user', 'managed turn');
  assert.equal(a.size, 1);
  assert.equal(b.size, 0);
});

void test('popLast and clear', () => {
  const history = new ManagedChatHistory();
  history.push('user', 'one');
  history.push('assistant', 'two');
  history.popLast();
  assert.deepEqual(history.getMessages(), [{ role: 'user', content: 'one' }]);
  history.clear();
  assert.equal(history.size, 0);
});
