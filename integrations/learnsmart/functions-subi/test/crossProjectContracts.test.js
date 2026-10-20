const test = require('node:test');
const assert = require('node:assert/strict');
const access = require('../src/services/accessService');
const entitlement = require('../src/services/subiCodeEntitlementService');
const fx = require('../src/services/fxRateService');

function store(docs = {}) {
  const reads = [];
  const writes = [];
  return { reads, writes, docs, collection(name) { return { doc(id) {
    const key = `${name}/${id}`;
    return { key, id, async get() { reads.push(key); return { id, exists: key in docs, data: () => docs[key] }; } };
  } }; }, async runTransaction(fn) { return fn({ set(ref, data) { writes.push(ref.key); docs[ref.key] = data; } }); } };
}

test('individual inherit and missing policy never read school policy, even with synthetic schoolId', async () => {
  for (const userPolicy of [undefined, { accessMode: 'inherit' }, { accessMode: 'enabled' }]) {
    const s = store({ 'systemConfig/subiAccess': { enabled: true }, ...(userPolicy ? { 'userPolicies/u': userPolicy } : {}) });
    const result = await access.resolveSubiAccess({ uid: 'u', accountType: 'individual', schoolId: 'individual_u', role: 'student' }, { store: s });
    assert.equal(result.allowed, true);
    assert.equal(s.reads.some(p => p.startsWith('schoolPolicies/')), false);
  }
});

test('individual without schoolId allowed; global and user disable still win', async () => {
  const input = { uid: 'u', accountType: 'individual', role: 'teacher' };
  for (const [global, mode, allowed] of [[true, 'inherit', true], [false, 'enabled', false], [true, 'disabled', false], [true, 'invalid', false]]) {
    const s = store({ 'systemConfig/subiAccess': { enabled: global }, 'userPolicies/u': { accessMode: mode } });
    assert.equal((await access.resolveSubiAccess(input, { store: s })).allowed, allowed);
  }
});

test('unsupported access accountType fails closed even with explicit enabled user policy', async () => {
  for (const accountType of [undefined, null, '', 'unknown']) {
    const s = store({ 'systemConfig/subiAccess': { enabled: true }, 'userPolicies/u': { accessMode: 'enabled' } });
    const r = await access.resolveSubiAccess({ uid: 'u', role: 'student', schoolId: 's', accountType }, { store: s });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ACCOUNT_TYPE_UNSUPPORTED');
  }
});

test('school policy and overrides remain authoritative', async () => {
  const s = store({ 'systemConfig/subiAccess': { enabled: true }, 'schoolPolicies/s': { roles: { student: { enabled: true }, teacher: { enabled: false } } } });
  for (const [role, allowed] of [['student', true], ['teacher', false]]) {
    assert.equal((await access.resolveSubiAccess({ uid: 'u', accountType: 'school', schoolId: 's', role }, { store: s })).allowed, allowed);
  }
  assert.equal(s.writes.length, 0);
});

test('entitlement never infers an unknown accountType as school', () => {
  for (const accountType of [undefined, null, '', 'unknown']) {
    const r = entitlement.evaluateSubiCodeEntitlement({ accountType });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'ACCOUNT_TYPE_UNSUPPORTED');
  }
});

test('canonical FX write is readable and malformed stored FX fails closed', async () => {
  const s = store();
  await fx.setFxRate({ rate: 90, source: 'manual', adminUid: 'test' }, { store: s });
  assert.equal((await fx.getFxRate({ store: s })).rate, 90);
  const valid = { ...s.docs['fxRates/USD_INR'] };
  for (const patch of [{ pair: 'OTHER' }, { rate: 1 }, { rate: '90' }, { fetchedAtMs: null }, { source: '' }, { snapshotId: '' }]) {
    s.docs['fxRates/USD_INR'] = { ...valid, ...patch };
    assert.equal(await fx.getFxRate({ store: s }), null, JSON.stringify(patch));
  }
});

test('FX writer rejects unreadable source metadata without any write', async () => {
  for (const source of [{}, 42, '   ', 'x'.repeat(65)]) {
    const s = store();
    await assert.rejects(fx.setFxRate({ rate: 90, source, adminUid: 'test' }, { store: s }), e => e.code === 'INVALID_REQUEST');
    assert.equal(s.writes.length, 0);
  }
});

test('an old wallet cannot authorize credits without a current paid-period anchor', async () => {
  const { orderingStore } = require('./orderingTx');
  const { ensureIndividualCreditReady } = require('../src/services/individualCreditReadyService');
  const s = orderingStore({ 'creditAccounts/u': { uid: 'u', subscriptionActive: true, topupRemainingCreditsMilli: 500000, cycleId: 'legacy' } });
  const before = JSON.stringify(s.state);
  await assert.rejects(ensureIndividualCreditReady({ uid: 'u', accountType: 'individual' }, { store: s,
    getProfile: async () => ({ accountType: 'individual', subscription: { subiCodeActive: true, renewalDateMs: Date.now() + 86400000 } }) }), e => e.code === 'SUBI_NO_PAID_PERIOD');
  assert.equal(JSON.stringify(s.state), before);
});

test('economics read failure cannot mint a default grant or partially write a new cycle', async () => {
  const { orderingStore } = require('./orderingTx');
  const { ensureCurrentCreditCycle } = require('../src/services/individualCreditCycleService');
  const s = orderingStore({ 'fxRates/USD_INR': { pair: 'USD_INR', rate: 90, source: 'manual', fetchedAtMs: 1, snapshotId: 's' } });
  const base = s.collection;
  s.collection = name => name === 'systemConfig' ? { doc() { return { get: async () => { throw new Error('unavailable'); } }; } } : base(name);
  const before = JSON.stringify(s.state);
  const now = Date.now();
  await assert.rejects(ensureCurrentCreditCycle({ uid: 'u', accountType: 'individual', userSubscription: { subiCodeActive: true, renewalDateMs: now + 86400000 },
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 86400000 }, { store: s }), e => e.code === 'SUBI_BILLING_UNAVAILABLE');
  assert.equal(JSON.stringify(s.state), before);
});

test('SUBI canonical paid dates cannot be extended by an unrelated website renewal date', () => {
  const { normalizeSubscription } = require('../src/services/learnsmartDirectoryService');
  const now = Date.now();
  const normalized = normalizeSubscription({ renewalDate: now + 1000000, subiCode: { enabled: true, periodEndMs: now - 10000, paidThroughMs: now - 5000, renewalDateMs: now - 1000 } });
  assert.equal(entitlement.evaluateSubiCodeEntitlement({ accountType: 'individual', userSubscription: normalized }).code, 'SUBI_PLAN_EXPIRED');
  const legacy = normalizeSubscription({ renewalDate: now + 1000000, subiCode: { tier: 'legacy' } });
  assert.equal(entitlement.evaluateSubiCodeEntitlement({ accountType: 'individual', userSubscription: legacy }).allowed, true);
});

test('cross-project error fixture is exactly recognized by backend safe-code normalization', () => {
  const codes = require('./fixtures/managed-errors.json');
  const { safeCode, safeCodes } = require('../src/utils/redact');
  assert.deepEqual(safeCodes, codes);
  for (const code of codes) assert.equal(safeCode(code), code);
  assert.equal(safeCode('unsafe provider detail'), 'INTERNAL');
});
