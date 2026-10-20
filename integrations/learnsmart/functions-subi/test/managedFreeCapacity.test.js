const test = require('node:test');
const assert = require('node:assert/strict');
const { acquireFreeCapacity, releaseFreeCapacity, recordFreeCapacityReset } = require('../src/services/managedFreeCapacityService');
function fixture() {
  const state = {}; let tail = Promise.resolve();
  const store = { collection: name => ({ doc: id => ({ key: `${name}/${id}` }) }), runTransaction: fn => {
    const job = tail.then(() => fn({ get: async ref => ({ exists: !!state[ref.key], data: () => state[ref.key] }), set: (ref, value) => { state[ref.key] = value; } }));
    tail = job.catch(() => {}); return job;
  } };
  return { store, state, nowMs: 1000000 };
}
test('free requests across different models share a bounded concurrency pool', async () => {
  const d = fixture();
  const results = await Promise.allSettled(['a', 'b', 'c'].map((attemptId, i) => acquireFreeCapacity({ upstreamModelId: `model/${i}:free`, attemptId }, d)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  const rejected = results.find(r => r.status === 'rejected').reason;
  assert.equal(rejected.code, 'PROVIDER_RATE_LIMITED'); assert.equal(rejected.providerAccepted, false);
  const lease = results.find(r => r.status === 'fulfilled').value;
  await releaseFreeCapacity(lease, d);
  assert.ok(await acquireFreeCapacity({ upstreamModelId: 'other/model:free', attemptId: 'new' }, d));
});
test('a verified shared provider reset blocks every free model until that time', async () => {
  const d = fixture();
  await recordFreeCapacityReset({ retryAtMs: d.nowMs + 86400000 }, d);
  await assert.rejects(acquireFreeCapacity({ upstreamModelId: 'different/model:free', attemptId: 'first' }, d), err => err.code === 'PROVIDER_RATE_LIMITED' && err.retryAfterMs === 86400000);
  assert.ok(await acquireFreeCapacity({ upstreamModelId: 'different/model:free', attemptId: 'later' }, { ...d, nowMs: d.nowMs + 86400001 }));
});
test('paid models bypass free capacity and an abandoned lease expires', async () => {
  const d = fixture();
  assert.equal(await acquireFreeCapacity({ upstreamModelId: 'model/paid', attemptId: 'paid' }, d), null);
  assert.deepEqual(d.state, {});
  await acquireFreeCapacity({ upstreamModelId: 'model/free:free', attemptId: 'one' }, d);
  await acquireFreeCapacity({ upstreamModelId: 'model/free:free', attemptId: 'two' }, d);
  assert.ok(await acquireFreeCapacity({ upstreamModelId: 'model/free:free', attemptId: 'expired' }, { ...d, nowMs: d.nowMs + 600000 }));
});
test('minute admission is shared even after requests finish; invalid reset hints cannot lock it forever', async () => {
  const d = fixture();
  for (let i = 0; i < 20; i++) { const lease = await acquireFreeCapacity({ upstreamModelId: 'model/free:free', attemptId: `a${i}` }, d); await releaseFreeCapacity(lease, d); }
  await assert.rejects(acquireFreeCapacity({ upstreamModelId: 'model/free:free', attemptId: 'extra' }, d), err => err.code === 'PROVIDER_RATE_LIMITED');
  await assert.rejects(recordFreeCapacityReset({ retryAtMs: Infinity }, d));
  assert.ok(await acquireFreeCapacity({ upstreamModelId: 'model/free:free', attemptId: 'next-minute' }, { ...d, nowMs: d.nowMs + 60001 }));
});
