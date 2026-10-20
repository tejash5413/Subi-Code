// test/managedChatConfig.test.js — server kill-switch tests (fakes only,
// except unauthenticated HTTP route guards). No deploys, no Send enablement.
const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/services/managedChatConfigService");
const { buildAdminApp } = require("../src/app");

function fakeStore() {
  const state = {};
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
    }),
    async runTransaction(fn) {
      const tx = {
        set: (ref, data) => {
          state[ref._key] = { ...(state[ref._key] || {}), ...data };
        },
        get: async (ref) => {
          const key = ref._key;
          return { exists: key in state, data: () => state[key] };
        },
      };
      return fn(tx);
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

// ---------- Availability semantics ----------

test("capability agrees with availability across mode matrix", () => {
  const cases = [
    [{ mode: "disabled", testUids: [] }, "u1", false],
    [{ mode: "test", testUids: ["u1"] }, "u1", true],
    [{ mode: "test", testUids: ["other"] }, "u1", false],
    [{ mode: "test", testUids: [] }, "u1", false],
    [{ mode: "enabled", testUids: [] }, "u1", true],
    [{ mode: "enabled", testUids: ["u1"] }, "u1", true],
    [{ mode: "weird", testUids: ["u1"] }, "u1", false],
    [null, "u1", false],
  ];
  for (const [cfg, uid, expected] of cases) {
    const avail = config.evaluateChatAvailability(cfg, uid);
    const cap = config.evaluateChatCapability(cfg, uid);
    assert.equal(cap.chatAvailable, expected, JSON.stringify(cfg));
    assert.equal(cap.chatAvailable, avail.allowed, `capability must agree with availability: ${JSON.stringify(cfg)}`);
  }
});

test("capability fields are categorical and bounded", () => {
  assert.deepEqual(config.evaluateChatCapability({ mode: "test", testUids: ["u1"] }, "u1"), {
    chatAvailable: true,
    chatModeClass: "test",
    testUidCount: 1,
    testUidMatched: true,
  });
  assert.deepEqual(config.evaluateChatCapability({ mode: "test", testUids: ["a", "b", 42, null] }, "zzz"), {
    chatAvailable: false,
    chatModeClass: "test",
    testUidCount: 2,
    testUidMatched: false,
  });
  assert.deepEqual(config.evaluateChatCapability({ mode: "enabled", testUids: ["u1"] }, "u1"), {
    chatAvailable: true,
    chatModeClass: "enabled",
    testUidCount: 1,
    testUidMatched: false,
  });
  assert.deepEqual(config.evaluateChatCapability({ mode: "bogus", testUids: ["u1"] }, "u1"), {
    chatAvailable: false,
    chatModeClass: "invalid",
    testUidCount: 1,
    testUidMatched: false,
  });
  assert.deepEqual(config.evaluateChatCapability(null, "u1"), {
    chatAvailable: false,
    chatModeClass: "invalid",
    testUidCount: 0,
    testUidMatched: false,
  });
});

test("missing config fails closed to disabled", async () => {
  const s = fakeStore();
  const out = await config.getManagedChatConfig(deps(s));
  assert.deepEqual({ mode: out.mode, testUids: out.testUids }, { mode: "disabled", testUids: [] });
  assert.deepEqual(config.evaluateChatAvailability(out, "any-uid"), { allowed: false, mode: "disabled" });
});

test("malformed config fails closed to disabled", async () => {
  const s = fakeStore();
  s._state["systemConfig/managedChat"] = { mode: "EVERYTHING", testUids: "yes" };
  const out = await config.getManagedChatConfig(deps(s));
  assert.equal(out.mode, "disabled");
  assert.deepEqual(config.evaluateChatAvailability(out, "u1"), { allowed: false, mode: "disabled" });
  // Non-string mode also fails closed.
  s._state["systemConfig/managedChat"] = { mode: 42 };
  const out2 = await config.getManagedChatConfig(deps(s));
  assert.equal(out2.mode, "disabled");
});

test("disabled blocks everyone", async () => {
  const s = fakeStore();
  s._state["systemConfig/managedChat"] = { mode: "disabled", testUids: ["u1"] };
  const out = await config.getManagedChatConfig(deps(s));
  assert.deepEqual(config.evaluateChatAvailability(out, "u1"), { allowed: false, mode: "disabled" });
});

test("test mode allows only allowlisted UIDs", async () => {
  const s = fakeStore();
  s._state["systemConfig/managedChat"] = { mode: "test", testUids: ["u1", "u2"] };
  const out = await config.getManagedChatConfig(deps(s));
  assert.deepEqual(config.evaluateChatAvailability(out, "u1"), { allowed: true, mode: "test" });
  assert.deepEqual(config.evaluateChatAvailability(out, "intruder"), { allowed: false, mode: "test" });
  // Never leaks membership reasoning — same shape for both outcomes.
  assert.deepEqual(Object.keys(config.evaluateChatAvailability(out, "u1")).sort(), ["allowed", "mode"]);
});

test("enabled allows normal eligible users", async () => {
  const s = fakeStore();
  s._state["systemConfig/managedChat"] = { mode: "enabled", testUids: [] };
  const out = await config.getManagedChatConfig(deps(s));
  assert.deepEqual(config.evaluateChatAvailability(out, "anyone"), { allowed: true, mode: "enabled" });
});

// ---------- Admin validation ----------

test("admin set validates mode, cap, dedupe, and exact shape", async () => {
  const s = fakeStore();
  const d = deps(s);
  await assert.rejects(config.setManagedChatConfig({ mode: "sometimes", testUids: [], adminUid: "a" }, d),
    (e) => e.code === "INVALID_REQUEST");
  await assert.rejects(config.setManagedChatConfig({ mode: "test", testUids: "u1", adminUid: "a" }, d),
    (e) => e.code === "INVALID_REQUEST");
  const eleven = Array.from({ length: 11 }, (_, i) => `u${i}`);
  await assert.rejects(config.setManagedChatConfig({ mode: "test", testUids: eleven, adminUid: "a" }, d),
    (e) => e.code === "INVALID_REQUEST");
  await assert.rejects(config.setManagedChatConfig({ mode: null, adminUid: "a" }, d),
    (e) => e.code === "INVALID_REQUEST");
  // Duplicates normalized; server stamps timestamps/identity.
  const ten = Array.from({ length: 10 }, (_, i) => `u${i}`);
  const out = await config.setManagedChatConfig(
    { mode: "test", testUids: [...ten, "u0", "  ", 42].filter((v) => typeof v === "string"), adminUid: "admin1" },
    d
  );
  assert.equal(out.mode, "test");
  assert.deepEqual(out.testUids, ten);
  assert.ok(out.updatedAt instanceof Date);
  assert.equal(out.updatedBy, "admin1");
  assert.equal(d.audits._list[0].action, "managed_chat_config.updated");
  // createdAt preserved across updates.
  const before = s._state["systemConfig/managedChat"].createdAt;
  await config.setManagedChatConfig({ mode: "disabled", adminUid: "a" }, d);
  assert.deepEqual(s._state["systemConfig/managedChat"].createdAt, before);
  assert.equal(s._state["systemConfig/managedChat"].mode, "disabled");
  // testUids retained but ignored when mode is not test.
  const read = await config.getManagedChatConfig(d);
  assert.equal(read.mode, "disabled");
});

test("non-string testUid entries rejected", async () => {
  const s = fakeStore();
  await assert.rejects(
    config.setManagedChatConfig({ mode: "test", testUids: ["u1", 42], adminUid: "a" }, deps(s)),
    (e) => e.code === "INVALID_REQUEST"
  );
});

// ---------- Route guards (unauthenticated only; no auth bypass) ----------

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

test("managed-chat config routes require auth (401 without token)", async () => {
  const s = await listen(buildAdminApp());
  try {
    const port = s.address().port;
    for (const [m, p, body] of [
      ["GET", "/admin/managed-chat-config", null],
      ["POST", "/admin/managed-chat-config", { mode: "disabled" }],
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: m,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  } finally {
    s.close();
  }
});
