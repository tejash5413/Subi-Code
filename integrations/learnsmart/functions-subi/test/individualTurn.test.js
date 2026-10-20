const test = require('node:test');
const assert = require('node:assert/strict');
const { orderingStore } = require('./orderingTx');
const svc = require('../src/services/individualTurnService');
test('enforcement-off admission is idempotent and never touches quota or wallet documents', async () => {
  const store = orderingStore();
  const args = { uid: 'u', requestId: 'r', accountType: 'individual', defaultMaxOutputTokens: 4096 };
  const r = await svc.reserveUsage(args, { store });
  await assert.rejects(svc.reserveUsage(args, { store }), e => e.code === 'REQUEST_IN_PROGRESS');
  await svc.markDispatched(r, { store });
  await assert.rejects(svc.markDispatched(r, { store }), e => e.code === 'REQUEST_IN_PROGRESS');
  await svc.markStarted(r, { store });
  await svc.commitUsage(r, { store });
  await assert.rejects(svc.reserveUsage(args, { store }), e => e.code === 'REQUEST_ALREADY_PROCESSED');
  assert.equal((await svc.commitUsage(r, { store })).alreadyTerminal, true);
  assert.ok(Object.keys(store.state).every(k => k.startsWith('individualTurn')));
});
test('admission concurrency is bounded and school calls write nothing', async () => {
  const store = orderingStore();
  const args = { uid: 'u', accountType: 'individual', defaultMaxOutputTokens: 4096 };
  const first = await svc.reserveUsage({ ...args, requestId: 'a' }, { store });
  await svc.reserveUsage({ ...args, requestId: 'b' }, { store });
  await assert.rejects(svc.reserveUsage({ ...args, requestId: 'c' }, { store }), e => e.code === 'TOO_MANY_ACTIVE_REQUESTS');
  await svc.failBeforeStart(first, { store });
  await svc.reserveUsage({ ...args, requestId: 'c' }, { store });
  const before = JSON.stringify(store.state);
  await assert.rejects(svc.reserveUsage({ ...args, accountType: 'school', requestId: 'school' }, { store }), e => e.code === 'ACCOUNT_TYPE_UNSUPPORTED');
  assert.equal(JSON.stringify(store.state), before);
});
