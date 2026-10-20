const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSharedFreeResetAtMs } = require('../src/utils/providerRetryTiming');
const headers = values => ({ get: key => values[key] ?? null });
test('only exhausted platform rate headers produce a bounded shared reset deadline', () => {
  const now = 1700000000000;
  assert.equal(parseSharedFreeResetAtMs(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 60000) / 1000) }), now), now + 60000);
  assert.equal(parseSharedFreeResetAtMs(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 86400000) }), now), now + 86400000);
  for (const values of [{ 'retry-after': '60' }, { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String((now + 60000) / 1000) }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'secret-or-invalid' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now - 1) }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 86400001) }]) assert.equal(parseSharedFreeResetAtMs(headers(values), now), undefined);
});
