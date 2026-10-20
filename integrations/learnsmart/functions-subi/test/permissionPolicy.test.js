const test = require('node:test');
const assert = require('node:assert/strict');
const { orderingStore } = require('./orderingTx');

const directory = orderingStore({
  'users/admin': { role: 'admin', status: 'active' },
  'users/student': { role: 'student', status: 'active', accountType: 'school', schoolId: 's' },
  'users/teacher': { role: 'teacher', status: 'active', accountType: 'school', schoolId: 's' },
  'users/individual': { role: 'student', status: 'active', accountType: 'individual', subscription: { subiCode: {
    enabled: true, status: 'active', product: 'subi-code', paidThroughMs: Date.now() + 86400000,
    periodStartMs: Date.now() - 86400000, periodEndMs: Date.now() + 86400000,
  } } },
  'schools/s': { accountType: 'school' },
});
const subi = orderingStore({
  'systemConfig/subiAccess': { enabled: true },
  'schoolPolicies/s': { roles: { student: { enabled: true, permissionProfileCeiling: 'session' }, teacher: { enabled: true, permissionProfileCeiling: 'full' } } },
});
const subiCollection = subi.collection.bind(subi);
subi.collection = name => ({ ...subiCollection(name), async add(data) {
  const id = `audit-${Object.keys(subi.state).length}`;
  subi.state[`${name}/${id}`] = data;
  return { id };
} });
const db = require.resolve('../src/db');
require.cache[db] = { id: db, filename: db, loaded: true, exports: { learnsmartDb: directory, subiDb: subi,
  admin: { auth: () => ({ verifyIdToken: async token => ({ uid: token }) }) } } };
const svc = require('../src/services/accessService');
const { buildManagedApp, buildAdminApp } = require('../src/app');
const audits = [];
function deps(store) { return { store, audits: { logAudit: async audit => audits.push(audit) } }; }

test('missing and malformed role ceilings default to Ask Approval', async () => {
  for (const ceiling of [undefined, null, 'FULL', ' session ', 'enabled', true, {}, []]) {
    const store = orderingStore({ 'schoolPolicies/s': { roles: { student: { enabled: true, permissionProfileCeiling: ceiling } } } });
    const policy = await svc.getSchoolAccess('s', deps(store));
    assert.equal(policy.roles.student.permissionProfileCeiling, 'ask');
    assert.equal(policy.roles.teacher.permissionProfileCeiling, 'ask');
  }
});

test('omitting ceilings preserves malformed stored fields while response remains fail closed', async () => {
  const store = orderingStore({ 'schoolPolicies/s': { roles: { student: { enabled: true, permissionProfileCeiling: 'legacy-invalid' } } } });
  const out = await svc.setSchoolAccess({ schoolId: 's', studentEnabled: true, teacherEnabled: false }, deps(store));
  assert.equal(store.state['schoolPolicies/s'].roles.student.permissionProfileCeiling, 'legacy-invalid');
  assert.equal('permissionProfileCeiling' in store.state['schoolPolicies/s'].roles.teacher, false);
  assert.equal(out.roles.student.permissionProfileCeiling, 'ask');
  assert.equal(out.roles.teacher.permissionProfileCeiling, 'ask');
});

test('optional updates preserve ceilings, nested metadata and audit committed policy', async () => {
  audits.length = 0;
  const store = orderingStore({ 'schoolPolicies/s': { retained: true, roles: {
    student: { enabled: true, permissionProfileCeiling: 'full', metadata: 'keep' },
    teacher: { enabled: true, permissionProfileCeiling: 'session' },
  } } });
  const out = await svc.setSchoolAccess({ schoolId: 's', studentEnabled: false, teacherEnabled: true, teacherPermissionProfileCeiling: 'ask', adminUid: 'admin' }, deps(store));
  assert.equal(out.roles.student.permissionProfileCeiling, 'full');
  assert.equal(out.roles.teacher.permissionProfileCeiling, 'ask');
  assert.equal(store.state['schoolPolicies/s'].roles.student.metadata, 'keep');
  assert.equal(store.state['schoolPolicies/s'].retained, true);
  assert.equal(audits[0].before.teacherPermissionProfileCeiling, 'session');
  assert.equal(audits[0].after.teacherPermissionProfileCeiling, 'ask');
});

test('transaction reads current policy rather than preserving a stale pretransaction snapshot', async () => {
  audits.length = 0;
  const store = orderingStore({ 'schoolPolicies/s': { roles: { student: { enabled: true, permissionProfileCeiling: 'ask' } } } });
  const run = store.runTransaction.bind(store);
  store.runTransaction = async fn => {
    store.state['schoolPolicies/s'].roles.student.permissionProfileCeiling = 'session';
    return run(fn);
  };
  const out = await svc.setSchoolAccess({ schoolId: 's', studentEnabled: false, teacherEnabled: true }, deps(store));
  assert.equal(out.roles.student.permissionProfileCeiling, 'session');
  assert.equal(audits[0].before.studentPermissionProfileCeiling, 'session');
});

test('service rejects invalid explicit ceilings before any write', async () => {
  const store = orderingStore({});
  for (const value of [null, '', 'Full', true, 1, {}, []]) {
    await assert.rejects(svc.setSchoolAccess({ schoolId: 's', studentEnabled: true, teacherEnabled: true, studentPermissionProfileCeiling: value }, deps(store)), { code: 'INVALID_REQUEST' });
  }
  assert.deepEqual(store.state, {});
});

test('transaction retry preserves the competing ceiling and audits only the committed attempt', async () => {
  audits.length = 0;
  const store = orderingStore({ 'schoolPolicies/s': { roles: {
    student: { enabled: true, permissionProfileCeiling: 'ask' },
    teacher: { enabled: true, permissionProfileCeiling: 'full' },
  } } });
  const run = store.runTransaction.bind(store);
  store.runTransaction = async fn => {
    // Simulate Firestore discarding the first optimistic attempt after an
    // overlapping admin commits a student-ceiling change.
    await fn({ get: ref => ref.get(), set() {} });
    store.state['schoolPolicies/s'].roles.student.permissionProfileCeiling = 'session';
    return run(fn);
  };
  const out = await svc.setSchoolAccess({ schoolId: 's', studentEnabled: true, teacherEnabled: true, teacherPermissionProfileCeiling: 'ask' }, deps(store));
  assert.equal(out.roles.student.permissionProfileCeiling, 'session');
  assert.equal(store.state['schoolPolicies/s'].roles.student.permissionProfileCeiling, 'session');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].before.studentPermissionProfileCeiling, 'session');
  assert.equal(audits[0].after.teacherPermissionProfileCeiling, 'ask');
});

test('an unavailable permission store cannot issue a permissive school lease', async () => {
  const store = { collection() { return { doc() { return { async get() { throw new Error('offline'); } }; } }; } };
  await assert.rejects(svc.getManagedPermissionPolicy({ accountType: 'school', schoolId: 's', role: 'teacher' }, deps(store)), { code: 'UNAVAILABLE' });
  const individual = await svc.getManagedPermissionPolicy({ accountType: 'individual', role: 'student' }, deps(store));
  assert.equal(individual.profileCeiling, 'full', 'individual policy does not depend on school storage');
});

test('managed permission projection is role scoped, expires in five minutes and ignores user override metadata', async () => {
  const store = orderingStore({ 'schoolPolicies/s': { roles: { student: { permissionProfileCeiling: 'session' }, teacher: { permissionProfileCeiling: 'full' } } },
    'userPolicies/u': { accessMode: 'enabled', lastKnownRole: 'teacher', permissionProfileCeiling: 'full' } });
  const before = Date.now();
  const policy = await svc.getManagedPermissionPolicy({ accountType: 'school', schoolId: 's', role: 'student', uid: 'u' }, deps(store));
  assert.equal(policy.profileCeiling, 'session');
  assert.equal(policy.source, 'school_role');
  assert.equal(policy.schemaVersion, 1);
  assert.ok(policy.validUntilMs >= before + 300000 && policy.validUntilMs <= Date.now() + 300000);
  assert.equal((await svc.getManagedPermissionPolicy({ accountType: 'individual', role: 'teacher' }, deps(store))).profileCeiling, 'full');
  for (const context of [{ accountType: 'school', schoolId: 's', role: 'admin' }, { accountType: 'school', role: 'student' }, { accountType: 'unknown', role: 'student' }]) {
    await assert.rejects(svc.getManagedPermissionPolicy(context, deps(store)), { code: 'INVALID_REQUEST' });
  }
});

async function withServer(app, run) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

test('real admin HTTP validates exact optional enums and returns both safe ceilings', async () => {
  await withServer(buildAdminApp(), async url => {
    for (const value of [null, 'Full', 'session ', {}, true]) {
      const response = await fetch(url + '/admin/schools/s/subi-access', { method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: JSON.stringify({ studentEnabled: true, teacherEnabled: true, studentPermissionProfileCeiling: value }) });
      assert.equal(response.status, 400);
    }
    const response = await fetch(url + '/admin/schools/s/subi-access', { headers: { authorization: 'Bearer admin' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.roles.student.permissionProfileCeiling, 'session');
    assert.equal(body.roles.teacher.permissionProfileCeiling, 'full');
    const saved = await fetch(url + '/admin/schools/s/subi-access', { method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: JSON.stringify({ studentEnabled: true, teacherEnabled: true, teacherPermissionProfileCeiling: 'session' }) });
    assert.equal(saved.status, 200);
    const out = await saved.json();
    assert.equal(out.roles.student.permissionProfileCeiling, 'session');
    assert.equal(out.roles.teacher.permissionProfileCeiling, 'session');
    const recorded = Object.entries(subi.state).find(([key]) => key.startsWith('auditLogs/'))[1];
    assert.equal(recorded.before.teacherPermissionProfileCeiling, 'full');
    assert.equal(recorded.after.teacherPermissionProfileCeiling, 'session');
  });
});

test('real managed HTTP uses authenticated role, ignores forged query role, and emits no policy on denial', async () => {
  subi.state['schoolPolicies/s'].roles.teacher.permissionProfileCeiling = 'full';
  subi.state['userPolicies/student'] = { accessMode: 'enabled', permissionProfileCeiling: 'full', lastKnownRole: 'teacher' };
  await withServer(buildManagedApp(), async url => {
    for (const [uid, ceiling, source] of [['student', 'session', 'school_role'], ['teacher', 'full', 'school_role'], ['individual', 'full', 'individual']]) {
      const response = await fetch(url + '/managed/access-status?role=teacher&permissionProfileCeiling=full', { headers: { authorization: 'Bearer ' + uid } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.allowed, true, JSON.stringify(body));
      assert.equal(body.permissionPolicy.profileCeiling, ceiling);
      assert.equal(body.permissionPolicy.source, source);
    }
    subi.state['systemConfig/subiAccess'].enabled = false;
    const denied = await fetch(url + '/managed/access-status', { headers: { authorization: 'Bearer student' } });
    const body = await denied.json();
    assert.equal(body.allowed, false);
    assert.equal('permissionPolicy' in body, false);
    subi.state['systemConfig/subiAccess'].enabled = true;
  });
});

test('real managed HTTP fails closed if permission refresh fails after access admission', async () => {
  const base = subi.collection;
  let schoolReads = 0;
  subi.collection = name => {
    const collection = base(name);
    return name !== 'schoolPolicies' ? collection : { ...collection, doc(id) {
      const ref = collection.doc(id);
      return { ...ref, async get() {
        if (++schoolReads > 1) throw new Error('permission refresh offline');
        return ref.get();
      } };
    } };
  };
  try {
    await withServer(buildManagedApp(), async url => {
      const response = await fetch(url + '/managed/access-status', { headers: { authorization: 'Bearer student' } });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.allowed, false);
      assert.equal(body.code, 'SUBI_ACCESS_UNAVAILABLE');
      assert.equal('permissionPolicy' in body, false);
    });
  } finally { subi.collection = base; }
});
