// Real auth -> directory -> managed routes, with isolated fake databases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { orderingStore } = require('./orderingTx');
const RealDate = Date;
const NOW = Date.UTC(2026, 9, 6, 12);
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } };
function store(seed) {
  const s = orderingStore(seed);
  const base = s.collection;
  s.collection = name => ({ ...base(name), doc(id) { const ref = base(name).doc(id); return { ...ref, async get() { return { ...await ref.get(), id }; } }; }, limit(n) { return { async get() {
    return { docs: Object.entries(s.state).filter(([key]) => key.startsWith(name + '/') && !key.slice(name.length + 1).includes('/'))
      .slice(0, n).map(([key, value]) => ({ id: key.slice(name.length + 1), data: () => value })) };
  } }; } });
  return s;
}
const directory = store({
  'users/school-user': { status: 'active', role: 'student', accountType: 'school', schoolId: 's1' },
  'schools/s1': { name: 'Test school', accountType: 'school' },
  'users/individual-user': { status: 'active', role: 'student', accountType: 'individual', subscription: { subiCode: {
    enabled: true, status: 'active', product: 'subi-code', periodStartMs: Date.UTC(2026, 9, 1),
    periodEndMs: Date.UTC(2026, 9, 4), paidThroughMs: Date.UTC(2026, 10, 1), renewalDateMs: Date.UTC(2026, 10, 1),
  } } },
});
const subi = store({
  'systemConfig/subiAccess': { enabled: true },
  'schoolPolicies/s1': { roles: { student: { enabled: true }, teacher: { enabled: false } } },
  'schoolLimits/s1': { monthlyTokens: { student: 10000, teacher: 20000 } },
  'schoolModelPolicies/s1': { roles: { student: { modelKeys: ['mdl_test'] }, teacher: { modelKeys: [] } } },
  'userPolicies/individual-user': { accessMode: 'inherit' },
  'userModelPolicies/individual-user': { modelMode: 'custom', modelKeys: [] },
  'userLimits/individual-user': { monthlyTokenMode: 'custom', monthlyTokens: 0 },
  'approvedModels/mdl_test': { displayName: 'Test Model', upstreamModelId: 'test/private', enabled: true,
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: true }, contextLength: 128000, pricing: { input: '0.000002', output: '0.00001' } },
  'fxRates/USD_INR': { pair: 'USD_INR', rate: 90, source: 'manual', fetchedAtMs: NOW, snapshotId: 'test-fx' },
});
const db = require.resolve('../src/db');
require.cache[db] = { id: db, filename: db, loaded: true, exports: { learnsmartDb: directory, subiDb: subi,
  admin: { auth: () => ({ verifyIdToken: async token => ({ uid: token }) }) } } };
const { buildManagedApp, buildAdminApp } = require('../src/app');

test('school and individual complete flows match the cross-project JSON fixture', async () => {
  const server = await new Promise(resolve => { const s = buildManagedApp().listen(0, () => resolve(s)); });
  const output = {};
  try {
    for (const [kind, uid] of [['school', 'school-user'], ['individual', 'individual-user']]) {
      output[kind] = {};
      const before = Object.keys(subi.state).filter(k => k.startsWith('creditAccounts/')).length;
      for (const endpoint of ['access-status', 'models', 'monthly-limit', 'subicode-status', 'usage']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/managed/${endpoint}`, { headers: { authorization: `Bearer ${uid}` } });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        output[kind][endpoint] = body;
        assert.equal(JSON.stringify(body).includes('test/private'), false);
      }
      if (kind === 'school') assert.equal(Object.keys(subi.state).filter(k => k.startsWith('creditAccounts/')).length, before);
      else {
        assert.ok(subi.state['creditAccounts/individual-user']);
        assert.equal(output.individual.models.models.length, 1, 'legacy model policies must not gate individuals');
        assert.equal(output.individual['monthly-limit'].credits.monthlyGrantMilli, 4500000);
        assert.equal('monthlyTokenLimit' in output.individual['monthly-limit'], false);
      }
    }
    const fixturePath = path.join(__dirname, 'fixtures/managed-contracts.json');
    assert.deepEqual(output, JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    // Current cycle survives an FX outage and cannot grant twice.
    const snapshot = JSON.stringify(subi.state['creditAccounts/individual-user']);
    delete subi.state['fxRates/USD_INR'];
    const response = await fetch(`http://127.0.0.1:${server.address().port}/managed/monthly-limit`, { headers: { authorization: 'Bearer individual-user' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), output.individual['monthly-limit']);
    assert.equal(JSON.stringify(subi.state['creditAccounts/individual-user']), snapshot);
  } finally { server.closeAllConnections(); server.close(); global.Date = RealDate; }
});

test('real directory projection admits legacy admin to Admin APIs and rejects a managed student without status', async () => {
  directory.state['users/legacy-admin'] = { role: 'admin' };
  directory.state['users/missing-status-student'] = { role: 'student', accountType: 'school', schoolId: 's1' };
  const server = await new Promise(resolve => { const s = buildAdminApp().listen(0, () => resolve(s)); });
  try {
    for (const route of ['/status', '/admin/subi-access', '/admin/approved-models', '/admin/individual-credit-economics']) {
      const r = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { authorization: 'Bearer legacy-admin' } });
      assert.equal(r.status, 200, `${route}: ${await r.text()}`);
    }
    const denied = await fetch(`http://127.0.0.1:${server.address().port}/status`, { headers: { authorization: 'Bearer missing-status-student' } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'FORBIDDEN');
  } finally { server.closeAllConnections(); server.close(); }
});

test('school list is the policy intersection while individuals receive unassigned compatible approved models', async () => {
  subi.state['approvedModels/mdl_unassigned'] = { displayName: 'Unassigned free model', upstreamModelId: 'vendor/free', enabled: true,
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: true }, pricing: { input: '0', output: '0' } };
  const server = await new Promise(resolve => { const s = buildManagedApp().listen(0, () => resolve(s)); });
  try {
    for (const [uid, included] of [['school-user', false], ['individual-user', true]]) {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/managed/models`, { headers: { authorization: `Bearer ${uid}` } });
      assert.equal(r.status, 200); const body = await r.json();
      assert.equal(body.models.some(model => model.modelKey === 'mdl_unassigned'), included);
    }
  } finally { server.closeAllConnections(); server.close(); }
});
