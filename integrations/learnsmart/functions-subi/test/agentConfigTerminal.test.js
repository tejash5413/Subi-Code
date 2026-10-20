// test/agentConfigTerminal.test.js — terminalEnabled is a first-class
// admin-managed gate (service level; fakes only). Previously unwritable via
// any API, forcing evaluateTerminalCapability to 'none'.
const test = require("node:test");
const assert = require("node:assert/strict");

const agentConfig = require("../src/services/managedAgentConfigService");
const auditService = require("../src/services/auditService");

function fakeStore() {
  const state = {};
  let tail = Promise.resolve();
  return {
    _state: state,
    collection: (name) => ({
      doc: (id) => ({
        _key: `${name}/${id}`,
        async get() {
          const key = `${name}/${id}`;
          return { id, exists: key in state, data: () => state[key] };
        },
      }),
      async add(doc) {
        const id = `audit-${Object.keys(state).length}`;
        state[`${name}/${id}`] = doc;
        return { id };
      },
    }),
    runTransaction(fn) {
      const cur = tail.then(async () => {
        const tx = {
          set: (ref, data, options) => {
            state[ref._key] = options && options.merge === false ? { ...data } : { ...(state[ref._key] || {}), ...data };
          },
          get: async (ref) => {
            const key = ref._key;
            return { exists: key in state, data: () => state[key] };
          },
        };
        await fn(tx);
      });
      tail = cur.catch(() => {});
      return cur;
    },
  };
}

function deps(store) {
  const audits = [];
  return {
    store,
    audits: {
      async logAudit(e) {
        audits.push(e);
        return { id: "a" };
      },
      _list: audits,
    },
  };
}

test('jobs qualification admits only listed identities under the existing agent gate', async () => {
  const store = fakeStore(); const d = deps(store);
  const out = await agentConfig.setManagedAgentConfig({
    mode: 'enabled', testUids: ['existing'], jobsEnabled: false,
    jobsTestUids: [' school-qualifier ', 'individual-qualifier', 'school-qualifier'],
    terminalEnabled: true, coordinationEnabled: false, adminUid: 'admin',
  }, d);
  assert.deepEqual(out.jobsTestUids, ['school-qualifier', 'individual-qualifier']);
  assert.equal(out.jobsEnabled, undefined);
  const read = await agentConfig.getManagedAgentConfig({ store });
  assert.equal(agentConfig.evaluateJobsCapability(read, 'school-qualifier'), 'jobs_v1');
  assert.equal(agentConfig.evaluateJobsCapability(read, 'individual-qualifier'), 'jobs_v1');
  assert.equal(agentConfig.evaluateJobsCapability(read, 'existing'), undefined);
  assert.equal(agentConfig.evaluateJobsCapability(read, 'other'), undefined);
  assert.equal(agentConfig.evaluateJobsCapability({ ...read, mode: 'disabled' }, 'school-qualifier'), undefined);
  assert.equal(agentConfig.evaluateJobsCapability({ ...read, mode: 'test' }, 'school-qualifier'), undefined);
  assert.equal(agentConfig.evaluateJobsCapability({ ...read, mode: 'test', testUids: ['school-qualifier'] }, 'school-qualifier'), 'jobs_v1');
  assert.equal(agentConfig.evaluateFileCapability(read, 'school-qualifier'), 'none');
  assert.equal(agentConfig.evaluateTerminalCapability(read, 'school-qualifier'), 'none');
  assert.equal(agentConfig.evaluateCoordinationCapability(read, 'school-qualifier'), undefined);
  assert.deepEqual(d.audits._list[0].before.jobsTestUids, []);
  assert.deepEqual(d.audits._list[0].after.jobsTestUids, out.jobsTestUids);
});

test('jobs qualification preserves omissions, audits clearing, and leaves other capability switches unchanged', async () => {
  const store = fakeStore(); const d = deps(store);
  store._state['systemConfig/managedAgent'] = { mode: 'enabled', testUids: ['existing'], jobsEnabled: false, jobsTestUids: ['qualifier'], terminalEnabled: true, coordinationEnabled: false };
  const set = value => agentConfig.setManagedAgentConfig({ mode: 'enabled', testUids: ['existing'], adminUid: 'admin', ...value }, d);
  const preserved = await set({});
  assert.deepEqual(preserved.jobsTestUids, ['qualifier']);
  assert.deepEqual(d.audits._list[0].before.jobsTestUids, ['qualifier']);
  assert.deepEqual(d.audits._list[0].after.jobsTestUids, ['qualifier']);
  const promoted = await set({ jobsEnabled: true, jobsTestUids: [] });
  assert.deepEqual(promoted.jobsTestUids, []);
  assert.equal(agentConfig.evaluateJobsCapability(promoted, 'other'), 'jobs_v1');
  assert.deepEqual(d.audits._list.at(-1).after.jobsTestUids, []);
  const cleared = await set({ jobsEnabled: false });
  assert.equal(agentConfig.evaluateJobsCapability(cleared, 'qualifier'), undefined);
  assert.equal(store._state['systemConfig/managedAgent'].terminalEnabled, true);
  assert.equal(store._state['systemConfig/managedAgent'].coordinationEnabled, false);
  assert.deepEqual(store._state['systemConfig/managedAgent'].testUids, ['existing']);
});

test('malformed jobs qualification lists reject writes and fail closed when already stored', async () => {
  const store = fakeStore(); const d = deps(store);
  const invalid = [null, true, 'qualifier', {}, [1], ['qualifier', null], [''], [' '.repeat(4)], ['x'.repeat(129)], Array.from({ length: 11 }, (_, i) => `qualifier-${i}`)];
  for (const jobsTestUids of invalid) {
    const before = JSON.stringify(store._state);
    await assert.rejects(agentConfig.setManagedAgentConfig({ mode: 'enabled', jobsTestUids, adminUid: 'admin' }, d), { code: 'INVALID_REQUEST' });
    assert.equal(JSON.stringify(store._state), before);
    assert.equal(d.audits._list.length, 0);
    store._state['systemConfig/managedAgent'] = { mode: 'enabled', jobsEnabled: false, jobsTestUids };
    const out = await agentConfig.getManagedAgentConfig({ store });
    assert.deepEqual(out.jobsTestUids, []);
    assert.equal(agentConfig.evaluateJobsCapability(out, 'qualifier'), undefined);
    assert.equal(agentConfig.evaluateJobsCapability(store._state['systemConfig/managedAgent'], 'qualifier'), undefined);
  }
});

test('admin jobs qualification route validates, round-trips and clears the protected configuration', async () => {
  const express = require('express'); const store = fakeStore(); const d = deps(store);
  const previousGet = agentConfig.getManagedAgentConfig; const previousSet = agentConfig.setManagedAgentConfig;
  agentConfig.getManagedAgentConfig = () => previousGet({ store });
  agentConfig.setManagedAgentConfig = input => previousSet(input, d);
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.subi = { uid: 'fixture-admin' }; next(); });
  app.use(require('../src/routes/adminManagedAgentConfig').adminManagedAgentConfigRouter());
  const server = await new Promise(resolve => { const local = app.listen(0, '127.0.0.1', () => resolve(local)); });
  const url = `http://127.0.0.1:${server.address().port}/admin/managed-agent-config`;
  const post = payload => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    const base = { mode: 'enabled', testUids: ['existing'] };
    let response = await post({ ...base, jobsEnabled: false, jobsTestUids: ['qualifier'], terminalEnabled: true, coordinationEnabled: false });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).jobsTestUids, ['qualifier']);
    response = await post(base); assert.equal(response.status, 200); assert.deepEqual((await response.json()).jobsTestUids, ['qualifier']);
    assert.deepEqual((await (await fetch(url)).json()).jobsTestUids, ['qualifier']);
    const before = JSON.stringify(store._state);
    for (const jobsTestUids of [null, 'qualifier', ['qualifier', 1], Array.from({ length: 11 }, (_, i) => `u-${i}`)]) {
      response = await post({ ...base, jobsTestUids }); assert.equal(response.status, 400);
    }
    assert.equal(JSON.stringify(store._state), before);
    response = await post({ ...base, jobsTestUids: [] });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).jobsTestUids, []);
    assert.equal(store._state['systemConfig/managedAgent'].jobsEnabled, false);
    assert.equal(store._state['systemConfig/managedAgent'].terminalEnabled, true);
    assert.equal(store._state['systemConfig/managedAgent'].coordinationEnabled, false);
  } finally { server.close(); agentConfig.getManagedAgentConfig = previousGet; agentConfig.setManagedAgentConfig = previousSet; }
});

test('coordination gate preserves omitted flags, audits explicit changes, and defaults disabled', async () => {
  const store = fakeStore(); const d = deps(store);
  assert.equal(agentConfig.evaluateCoordinationCapability(await agentConfig.getManagedAgentConfig({ store }), 'u1'), undefined);
  const set = value => agentConfig.setManagedAgentConfig({ mode: 'test', testUids: ['u1'], adminUid: 'admin', ...value }, d);
  let out = await set({ jobsEnabled: true, coordinationEnabled: true, terminalEnabled: true });
  assert.equal(out.coordinationEnabled, true); assert.equal(agentConfig.evaluateCoordinationCapability(out, 'u1'), 'coordination_v1');
  assert.equal(d.audits._list[0].before.coordinationEnabled, false); assert.equal(d.audits._list[0].after.coordinationEnabled, true);
  out = await set({}); assert.equal(out.coordinationEnabled, true); assert.equal(store._state['systemConfig/managedAgent'].coordinationEnabled, true);
  assert.equal(out.jobsEnabled, true); assert.equal(out.terminalEnabled, true);
  out = await set({ coordinationEnabled: false }); assert.equal(out.coordinationEnabled, undefined);
  assert.equal(agentConfig.evaluateCoordinationCapability(out, 'u1'), undefined); assert.equal(d.audits._list.at(-1).after.coordinationEnabled, false);
  for (const coordinationEnabled of [null, 1, 'true', {}, []]) {
    const before = JSON.stringify(store._state);
    await assert.rejects(set({ coordinationEnabled }), e => e.code === 'INVALID_REQUEST'); assert.equal(JSON.stringify(store._state), before);
  }
});

test("terminalEnabled round-trips through setter and getter", async () => {
  const s = fakeStore();
  const d = deps(s);
  let out = await agentConfig.setManagedAgentConfig(
    { mode: "test", testUids: ["u1"], terminalEnabled: true, adminUid: "admin-1" },
    d
  );
  assert.equal(out.mode, "test");
  assert.equal(out.terminalEnabled, true);
  const read = await agentConfig.getManagedAgentConfig({ store: s });
  assert.equal(read.terminalEnabled, true);
  assert.equal(agentConfig.evaluateTerminalCapability(read, "u1"), "terminal");
  assert.equal(agentConfig.evaluateTerminalCapability(read, "u2"), "none");
});

test("omitted terminalEnabled preserves the stored gate (legacy callers safe)", async () => {
  const s = fakeStore();
  const d = deps(s);
  await agentConfig.setManagedAgentConfig(
    { mode: "test", testUids: ["u1"], terminalEnabled: true, adminUid: "a" },
    d
  );
  const out = await agentConfig.setManagedAgentConfig(
    { mode: "test", testUids: ["u1"], adminUid: "a" },
    d
  );
  assert.equal(out.terminalEnabled, true);
  const read = await agentConfig.getManagedAgentConfig({ store: s });
  assert.equal(read.terminalEnabled, true);
});

test("explicit false clears the gate; non-boolean rejects", async () => {
  const s = fakeStore();
  const d = deps(s);
  await agentConfig.setManagedAgentConfig(
    { mode: "test", testUids: ["u1"], terminalEnabled: true, adminUid: "a" },
    d
  );
  const out = await agentConfig.setManagedAgentConfig(
    { mode: "test", testUids: ["u1"], terminalEnabled: false, adminUid: "a" },
    d
  );
  assert.ok(!("terminalEnabled" in out));
  const read = await agentConfig.getManagedAgentConfig({ store: s });
  assert.equal(agentConfig.evaluateTerminalCapability(read, "u1"), "none");
  await assert.rejects(
    agentConfig.setManagedAgentConfig(
      { mode: "test", testUids: ["u1"], terminalEnabled: "yes", adminUid: "a" },
      d
    ),
    (e) => e.code === "INVALID_REQUEST"
  );
});

test('managed agent config persists and emits its audit using the real audit writer', async () => {
  const store = fakeStore();
  store._state['systemConfig/managedAgent'] = { mode: 'test', testUids: ['old-tester'], terminalEnabled: true };
  const result = await agentConfig.setManagedAgentConfig(
    { mode: 'enabled', testUids: [], adminUid: 'admin-1' },
    { store, audits: auditService }
  );
  assert.equal(result.mode, 'enabled');
  assert.deepEqual(result.testUids, []);
  assert.equal(result.terminalEnabled, true);
  const persisted = await agentConfig.getManagedAgentConfig({ store });
  assert.equal(persisted.mode, 'enabled');
  assert.deepEqual(persisted.testUids, []);
  assert.equal(persisted.terminalEnabled, true);
  assert.equal(persisted.updatedBy, 'admin-1');
  const audits = Object.entries(store._state).filter(([key]) => key.startsWith('auditLogs/')).map(([, doc]) => doc);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].adminUid, 'admin-1');
  assert.equal(audits[0].action, 'managed_agent_config.updated');
  assert.equal(audits[0].result, 'success');
  assert.deepEqual(audits[0].before, { mode: 'test', testUids: ['old-tester'], terminalEnabled: true });
  assert.deepEqual(audits[0].after, { mode: 'enabled', testUids: [], terminalEnabled: true });
});

test('malformed managed agent audit actions are rejected without writing an audit', async () => {
  const store = fakeStore();
  await assert.rejects(
    auditService.logAudit({ adminUid: 'admin-1', action: 'managed_agent_config.updated.invalid', result: 'success' }, store),
    /auditService: unknown action/
  );
  assert.deepEqual(store._state, {});
});

test('admin config route accepts only an explicit boolean coordination gate and preserves omissions', async () => {
  const express = require('express'); const store = fakeStore(); const d = deps(store);
  const previousGet = agentConfig.getManagedAgentConfig; const previousSet = agentConfig.setManagedAgentConfig;
  agentConfig.getManagedAgentConfig = () => previousGet({ store });
  agentConfig.setManagedAgentConfig = input => previousSet(input, d);
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.subi = { uid: 'fixture-admin' }; next(); });
  app.use(require('../src/routes/adminManagedAgentConfig').adminManagedAgentConfigRouter());
  const server = await new Promise(resolve => { const local = app.listen(0, '127.0.0.1', () => resolve(local)); });
  const url = `http://127.0.0.1:${server.address().port}/admin/managed-agent-config`;
  const post = payload => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    const base = { mode: 'test', testUids: ['u1'] };
    let response = await post({ ...base, jobsEnabled: true, coordinationEnabled: true }); assert.equal(response.status, 200);
    assert.equal((await response.json()).coordinationEnabled, true);
    response = await post(base); assert.equal(response.status, 200); assert.equal((await response.json()).coordinationEnabled, true);
    assert.equal((await (await fetch(url)).json()).coordinationEnabled, true);
    const before = JSON.stringify(store._state);
    for (const value of ['true', null, 1]) { response = await post({ ...base, coordinationEnabled: value }); assert.equal(response.status, 400); }
    response = await post({ ...base, coordinationEnabled: true, owner: {} }); assert.equal(response.status, 400); assert.equal(JSON.stringify(store._state), before);
    response = await post({ ...base, coordinationEnabled: false }); assert.equal(response.status, 200); assert.equal((await response.json()).coordinationEnabled, undefined);
    assert.equal(store._state['systemConfig/managedAgent'].coordinationEnabled, false); assert.equal(d.audits._list.at(-1).after.coordinationEnabled, false);
  } finally { server.close(); agentConfig.getManagedAgentConfig = previousGet; agentConfig.setManagedAgentConfig = previousSet; }
});
