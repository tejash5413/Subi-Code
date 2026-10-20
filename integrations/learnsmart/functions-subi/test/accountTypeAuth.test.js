const test = require("node:test");
const assert = require("node:assert/strict");

let profile;
const dbPath = require.resolve("../src/db");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  admin: { auth: () => ({ verifyIdToken: async () => ({ uid: "u1" }) }) },
} };
const directoryPath = require.resolve("../src/services/learnsmartDirectoryService");
require.cache[directoryPath] = { id: directoryPath, filename: directoryPath, loaded: true,
  exports: { getUserProfile: async () => profile, getSchool: async () => ({ accountType: 'school' }) } };
const { requireAuth } = require("../src/middleware/auth");

async function authenticate(accountType, managedOnly = true, role = "student") {
  profile = { role, status: "active", schoolId: "s1", accountType };
  const req = { headers: { authorization: "Bearer test-token" } };
  const out = { next: false, status: 200, body: null };
  const res = { status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; } };
  await requireAuth({ managedOnly })(req, res, () => { out.next = true; });
  return out;
}

test("managed auth rejects unknown account types before any managed route can fall back to school", async () => {
  for (const accountType of [undefined, null, "", "unknown", "admin"]) {
    const out = await authenticate(accountType);
    assert.equal(out.next, false, String(accountType));
    assert.equal(out.status, 403);
    assert.equal(out.body.error.code, "ACCOUNT_TYPE_UNSUPPORTED");
  }
});

test("managed auth preserves school and individual admission; admin auth remains separate", async () => {
  assert.equal((await authenticate("school")).next, true);
  assert.equal((await authenticate("individual")).next, true);
  assert.equal((await authenticate(null, false, "superadmin")).next, true);
});

async function authenticateProfile(value, managedOnly = false) {
  profile = value;
  const out = { next: false, status: 200, body: null };
  const res = { status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; } };
  await requireAuth({ managedOnly })({ headers: { authorization: 'Bearer test-token' } }, res, () => { out.next = true; });
  return out;
}

test('legacy directory superadmins without status can reach Admin middleware only', async () => {
  for (const role of ['admin', 'superadmin', 'super_admin', 'super admin']) {
    const value = { role, status: '', statusConfigured: false, accountType: null };
    assert.equal((await authenticateProfile(value)).next, true, role);
    assert.equal((await authenticateProfile(value, true)).next, false, 'managed route must stay closed');
  }
});

test('missing managed status and explicit disabled or malformed admin status fail closed', async () => {
  for (const role of ['student', 'teacher', 'schooladmin']) {
    assert.equal((await authenticateProfile({ role, status: '', statusConfigured: false })).next, false);
  }
  for (const status of ['inactive', 'disabled', 'suspended', '', 'invalid']) {
    assert.equal((await authenticateProfile({ role: 'admin', status, statusConfigured: true })).next, false, status);
  }
});

test("unknown accounts fail closed on all managed HTTP surfaces including chat and search", async () => {
  const app = require("../src/app");
  profile = { role: "student", status: "active", schoolId: "s1", accountType: "unknown" };
  const surfaces = [
    [app.buildManagedApp(), "GET", ["/managed/access-status", "/managed/subicode-status", "/managed/models", "/managed/monthly-limit", "/managed/usage"]],
    [app.buildManagedChatApp(), "POST", ["/chat"]],
    [app.buildManagedAgentApp(), "POST", ["/agent/turn", "/agent/search"]],
    [app.buildBillingApp(), "POST", ["/subi/billing/quote", "/subi/billing/order", "/subi/topups/quote", "/subi/topups/order"]],
  ];
  for (const [surface, method, paths] of surfaces) {
    const server = await new Promise(resolve => { const s = surface.listen(0, () => resolve(s)); });
    try {
      for (const route of paths) {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
          method, headers: { authorization: "Bearer test-token" },
        });
        assert.equal(res.status, 403, route);
        assert.equal((await res.json()).error.code, "ACCOUNT_TYPE_UNSUPPORTED", route);
      }
    } finally { server.close(); }
  }
});
