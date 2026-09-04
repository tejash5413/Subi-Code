import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedChatController, ManagedChatSendEvent } from '../managedChatController';
import type { ManagedChatSender } from '../managedChatController';

function neverSender(): ManagedChatSender {
  const sender = (): Promise<{ requestId: string; modelKey: string }> => {
    throw new Error('sender must not be invoked while the production gate is FALSE');
  };
  return sender as unknown as ManagedChatSender;
}

void test('FALSE gate rejects before network, history untouched', async () => {
  let calls = 0;
  const sender = ((): Promise<{ requestId: string; modelKey: string }> => {
    calls += 1;
    throw new Error('unreachable');
  }) as unknown as ManagedChatSender;
  const controller = new ManagedChatController(sender);
  const events: ManagedChatSendEvent[] = [];
  await controller.send({
    requestId: 1,
    idToken: 'tok',
    modelKey: 'mdl_a',
    text: 'hello',
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 0);
  assert.deepEqual(events, [
    { type: 'error', requestId: 1, code: 'managed', message: 'Managed chat will be enabled in the next SUBI phase.' },
  ]);
  assert.equal(controller.getHistory().length, 0);
  assert.equal(controller.isActive, false);
  void neverSender;
});

void test('clearHistory and abort are safe when idle', () => {
  const controller = new ManagedChatController(neverSender());
  controller.clearHistory();
  controller.abort();
  assert.equal(controller.isActive, false);
  assert.deepEqual(controller.getHistory(), []);
});
