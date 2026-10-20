// test/managedChatRoute.test.js — HTTP route integration (Phase 9A.2).
// Exercises the REAL POST /chat Express route (+ GET /managed/usage and the
// admin config routes) end to end. Fakes only: auth, directory (via stubbed
// req.subi), subi Firestore, Secret Manager resolver, fetch/OpenRouter.
// No real provider. No production Firestore. No deploys.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const { writeDoc } = require("./orderingTx");

// ---------- Fake subi Firestore: serializing, atomic, return-preserving ----------
// Transactions queue and run strictly one at a time (models serializable
// execution for our single read-modify-write-per-document pattern). The
// callback return value is propagated, matching real Firestore.
function makeFakeSubiDb() {
  const state = {};
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      return {
        _key: key,
        async get() {
          return { id, exists: key in state, data: () => state[key] };
        },
        collection: (sub) => coll(`${key}/${sub}`),
      };
    },
    limit: (n) => ({
      async get() {
        const docs = Object.entries(state)
          .filter(([k]) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/"))
          .slice(0, n)
          .map(([k, v]) => ({ id: k.slice(prefix.length + 1), data: () => v }));
        return { docs };
      },
    }),
    add: async (doc) => {
      const id = `auto${Object.keys(state).length}`;
      state[`${prefix}/${id}`] = doc;
      return { id };
    },
  });
  let tail = Promise.resolve();
  return {
    _state: state,
    collection: (name) => coll(name),
    runTransaction(fn) {
      const cur = tail.then(async () => {
        const tx = {
          set: (ref, data, options) => {
            state[ref._key] = writeDoc(state[ref._key], data, options);
          },
          get: async (ref) => {
            const key = ref._key;
            return { exists: key in state, data: () => state[key] };
          },
        };
        return fn(tx);
      });
      tail = cur.catch(() => {});
      return cur;
    },
  };
}

// ---------- Boot: fresh module graph, fake db, stubbed auth ----------
const SRC_FRAG = path.join("functions-subi", "src");

function boot({ user, store, profile, school, schoolReadError = false } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(SRC_FRAG)) delete require.cache[k];
  }
  const dbPath = require.resolve("../src/db");
  const fake = store || makeFakeSubiDb();
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { admin: {}, learnsmartDb: {}, subiDb: fake },
  };
  const authMod = require("../src/middleware/auth");
  authMod.requireAuth = () => (req, res, next) => {
    if (!user) return res.status(401).json({ error: "Missing auth token" });
    req.subi = { ...user };
    next();
  };
  const directory = require('../src/services/learnsmartDirectoryService');
  directory.getUserProfile = async () => profile === undefined ? { ...user, status: 'active', subscription: null } : profile;
  directory.getSchool = async id => {
    if (schoolReadError) throw new Error('school directory unavailable');
    return school === undefined ? id === user?.schoolId ? { id, accountType: 'school', subscription: null } : null : school;
  };
  const app = require("../src/app");
  return {
    fake,
    buildManagedChatApp: app.buildManagedChatApp,
    buildAdminApp: app.buildAdminApp,
    buildManagedApp: app.buildManagedApp,
    mods: {
      aiConnection: require("../src/services/aiConnectionService"),
      access: require("../src/services/accessService"),
      effective: require("../src/services/effectiveModelService"),
      limits: require("../src/services/monthlyLimitService"),
      quota: require("../src/services/usageQuotaService"),
      chatConfig: require("../src/services/managedChatConfigService"),
      validator: require("../src/services/managedChatValidator"),
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

// ---------- SSE + provider fakes ----------

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";

function sseBody(chunks, { hang = false } = {}) {
  return new ReadableStream({
    start(c) {
      for (const b of chunks) c.enqueue(Buffer.from(b));
      if (!hang) c.close();
    },
  });
}

// Hanging provider stream that faithfully replicates undici abort semantics:
// an aborted fetch signal destroys the body, rejecting pending reads. (The
// service relies on this — nothing else wakes a blocked reader.read().)
function hangingBody(init, firstChunk) {
  return new ReadableStream({
    start(c) {
      if (firstChunk) c.enqueue(Buffer.from(firstChunk));
      const sig = init && init.signal;
      if (sig) {
        if (sig.aborted) {
          try {
            c.error(new Error("aborted"));
          } catch (_) {
            // Already closed; nothing to do.
          }
          return;
        }
        sig.addEventListener(
          "abort",
          () => {
            try {
              c.error(new Error("aborted"));
            } catch (_) {
              // Already closed; nothing to do.
            }
          },
          { once: true }
        );
      }
    },
    cancel() {},
  });
}

// Transport failure delivered AFTER already-queued chunks drain. (Calling
// controller.error() synchronously with enqueue() would discard the queue
// per WHATWG semantics — unlike a real socket dying mid-stream.)
function failingBody(init, firstChunk, err, delayMs = 100) {
  return new ReadableStream({
    start(c) {
      if (firstChunk) c.enqueue(Buffer.from(firstChunk));
      const timer = setTimeout(() => {
        try {
          c.error(err);
        } catch (_) {
          // Already closed; nothing to do.
        }
      }, delayMs);
      const sig = init && init.signal;
      if (sig) {
        sig.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            try {
              c.error(new Error("aborted"));
            } catch (_) {
              // Already closed; nothing to do.
            }
          },
          { once: true }
        );
      }
    },
    cancel() {},
  });
}

function usageFrame(inT, outT, text) {
  return frame({ choices: [{ delta: { content: text } }], usage: { prompt_tokens: inT, completion_tokens: outT } });
}

function providerOK(chunks, seen) {
  return async (url, init) => {
    seen.calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, headers: { get: () => "text/event-stream" }, body: sseBody(chunks) };
  };
}

function providerStatus(status, seen) {
  return async (url, init) => {
    seen.calls.push({ url, body: init.body });
    return { status, headers: { get: () => null }, body: null };
  };
}

async function readEvents(res) {
  const text = await res.text();
  return {
    text,
    events: text
      .split("\n\n")
      .filter((s) => s.trim())
      .map((block) => {
        const lines = block.split("\n");
        const ev = (lines.find((l) => l.startsWith("event:")) || "").slice(6).trim();
        const dataLine = lines.find((l) => l.startsWith("data:")) || "";
        return { event: ev, data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : null };
      }),
  };
}

// Provider fetch stub: intercepts ONLY OpenRouter calls. Localhost traffic
// (the test client talking to the Express server under test) always uses
// the real fetch — otherwise postChat would hit the stub and fake-pass.
function withFetch(fakeProvider, fn) {
  const real = global.fetch;
  global.fetch = (url, init) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:") || u.startsWith("http://localhost:")) {
      return real(url, init);
    }
    return fakeProvider(url, init);
  };
  return (async () => {
    try {
      return await fn();
    } finally {
      global.fetch = real;
    }
  })();
}

// ---------- Seeding ----------

const USER = { uid: "u1", schoolId: "s1", role: "student", accountType: "school" };

for (const scenario of [
  { name: 'expired school subscription', school: { id: 's1', accountType: 'school', subscription: { renewalDateMs: Date.now() - 60000 } }, status: 403, code: 'SUBI_PLAN_EXPIRED' },
  { name: 'deleted school', school: null, status: 503, code: 'SUBI_ACCESS_UNAVAILABLE' },
  { name: 'deleted profile', profile: null, status: 503, code: 'SUBI_ACCESS_UNAVAILABLE' },
  { name: 'removed school link', profile: { ...USER, schoolId: '' }, status: 503, code: 'SUBI_ACCESS_UNAVAILABLE' },
  { name: 'incorrect school type', school: { id: 's1', accountType: 'individual' }, status: 403, code: 'FORBIDDEN' },
  { name: 'unavailable school directory', schoolReadError: true, status: 503, code: 'SUBI_ACCESS_UNAVAILABLE' },
]) {
  test(`legacy school chat rechecks current entitlement before quota: ${scenario.name}`, async () => {
    const { fake, buildManagedChatApp, mods } = boot({ user: USER, ...scenario });
    seedBaseline(fake._state, { 'systemConfig/managedChat': { mode: 'enabled', testUids: [] } });
    const before = JSON.parse(JSON.stringify(fake._state));
    let keyReads = 0;
    let dispatches = 0;
    mods.aiConnection.resolveActiveManagedKey = async () => { keyReads++; return Buffer.from('test-key'); };
    await withFetch(async () => {
      dispatches++;
      return { status: 200, body: sseBody([Buffer.from(frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + DONE)]) };
    }, async () => {
      const server = await listen(buildManagedChatApp());
      try {
        const result = await postChat(server.address().port, chatBody());
        const text = await result.text();
        assert.equal(result.status, scenario.status, text);
        assert.equal(JSON.parse(text).error.code, scenario.code);
      } finally { server.close(); }
    });
    assert.equal(keyReads, 0);
    assert.equal(dispatches, 0);
    assert.deepEqual(fake._state, before);
  });
}
const ADMIN = { uid: "admin1", schoolId: "", role: "superadmin" };
const SENTINEL = "SENTINEL PROMPT TEXT ABCZZ";
const UPSTREAM = "vendor/model-a";
const KEY_MATERIAL = "sk-test-managed-key-xyz";

function seedBaseline(st, over = {}) {
  st["systemConfig/managedChat"] = { mode: "enabled", testUids: [] };
  st["systemConfig/subiAccess"] = { enabled: true };
  st["schoolPolicies/s1"] = { roles: { student: { enabled: true }, teacher: { enabled: true } } };
  st["approvedModels/mdl_a"] = {
    modelKey: "mdl_a",
    displayName: "Model A",
    upstreamModelId: UPSTREAM,
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
    contextLength: 8192,
  };
  st["schoolModelPolicies/s1"] = {
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_a"] } },
  };
  st["schoolLimits/s1"] = { monthlyTokens: { student: 100000, teacher: 100000 } };
  Object.assign(st, over);
}

function chatBody(over = {}) {
  return {
    requestId: "r1",
    modelKey: "mdl_a",
    messages: [{ role: "user", content: "Hello" }],
    ...over,
  };
}

async function postChat(port, body) {
  return fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ridHash(uid, req) {
  return crypto.createHash("sha256").update(`${uid}\0${req}`, "utf8").digest("hex");
}

function monthOf(mods) {
  return mods.quota.currentMonthIST();
}

// Response-leak assertion shared across chat tests.
const BANNED_RESPONSE = [UPSTREAM, KEY_MATERIAL, "testUids", "reservedTokens", "reservationId", "_key", "stack", "Error:"];
function assertNoLeakResponse(text, what) {
  for (const banned of BANNED_RESPONSE) {
    assert.equal(text.includes(banned), false, `${what}: response leaks ${banned}`);
  }
}

// Persisted-state leak assertion: no message text / key material anywhere;
// upstream IDs only inside the admin-owned approvedModels master catalogue
// (never in usage/reservation docs); testUids only inside the admin-owned
// systemConfig/managedChat doc (never in user-accessible state).
function assertNoLeakState(state, what) {
  const dumpedAll = JSON.stringify(state);
  for (const banned of [SENTINEL, KEY_MATERIAL]) {
    assert.equal(dumpedAll.includes(banned), false, `${what}: state leaks ${banned}`);
  }
  const nonCatalog = Object.entries(state)
    .filter(([k]) => !k.startsWith("approvedModels/"))
    .map(([, v]) => v);
  assert.equal(JSON.stringify(nonCatalog).includes(UPSTREAM), false, `${what}: non-catalog state leaks upstream`);
  // auditLogs/* legitimately record the allowlist change for Superadmin
  // review (admin-only collection, asserted separately per entry).
  const nonConfig = Object.entries(state).filter(([k]) => k !== "systemConfig/managedChat" && !k.startsWith("auditLogs/"));
  assert.equal(JSON.stringify(nonConfig).includes("testUids"), false, `${what}: non-config state leaks testUids`);
}

// ---------- Gate tests (§6-13) ----------

test("disabled mode blocks before quota/key/provider", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { "systemConfig/managedChat": { mode: "disabled", testUids: [] } });
  let keys = 0;
  mods.aiConnection.resolveActiveManagedKey = async () => {
    keys += 1;
    return Buffer.from(KEY_MATERIAL);
  };
  const seen = { calls: [] };
  await withFetch(providerOK([frame({ choices: [{ delta: { content: "Hi" } }] }), DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "MANAGED_CHAT_DISABLED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(keys, 0);
  assert.equal(seen.calls.length, 0);
  assert.deepEqual(Object.keys(fake._state).filter((k) => k.startsWith("usageMonthly/")), []);
});

test("missing chat config fails closed", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  delete fake._state["systemConfig/managedChat"];
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "MANAGED_CHAT_DISABLED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
  assert.deepEqual(Object.keys(fake._state).filter((k) => k.startsWith("usageMonthly/")), []);
});

test("malformed chat config fails closed", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { "systemConfig/managedChat": { mode: "EVERYTHING", testUids: "yes" } });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "MANAGED_CHAT_DISABLED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
});

test("test mode rejects non-allowlisted UID without revealing membership", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { "systemConfig/managedChat": { mode: "test", testUids: ["someone-else"] } });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.deepEqual(body, { error: { code: "MANAGED_CHAT_DISABLED" } });
      assert.ok(!JSON.stringify(body).includes("someone-else"));
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
  assert.deepEqual(Object.keys(fake._state).filter((k) => k.startsWith("usageMonthly/")), []);
});

test("test mode allowlist still requires Access", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, {
    "systemConfig/managedChat": { mode: "test", testUids: ["u1"] },
    "systemConfig/subiAccess": { enabled: false },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "SUBI_ACCESS_DISABLED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
  assert.deepEqual(Object.keys(fake._state).filter((k) => k.startsWith("usageMonthly/")), []);
});

test("test mode allowlist still requires assigned model", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { "systemConfig/managedChat": { mode: "test", testUids: ["u1"] } });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody({ modelKey: "mdl_nope" }));
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "MODEL_NOT_ALLOWED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
  assert.deepEqual(Object.keys(fake._state).filter((k) => k.startsWith("usageMonthly/")), []);
});

test("monthly limit gates: not-configured and zero", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  delete fake._state["schoolLimits/s1"];
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "MONTHLY_LIMIT_NOT_CONFIGURED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
  const second = boot({ user: USER });
  seedBaseline(second.fake._state, { "schoolLimits/s1": { monthlyTokens: { student: 0, teacher: 0 } } });
  second.mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen2 = { calls: [] };
  await withFetch(providerOK([DONE], seen2), async () => {
    const s = await listen(second.buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "MONTHLY_LIMIT_EXCEEDED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen2.calls.length, 0);
});

// ---------- Ordering + pre-provider failures (§14-17) ----------

test("successful route order: auth, validate, mode, access, model, limit, reserve, key, dispatch, fetch", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  const order = [];
  const origValidate = mods.validator.validateChatBody;
  mods.validator.validateChatBody = (b) => {
    order.push("validate");
    return origValidate(b);
  };
  const origGate = mods.chatConfig.getManagedChatConfig;
  mods.chatConfig.getManagedChatConfig = async (...a) => {
    order.push("mode");
    return origGate(...a);
  };
  const origAccess = mods.access.resolveSubiAccess;
  mods.access.resolveSubiAccess = async (...a) => {
    order.push("access");
    return origAccess(...a);
  };
  const origModels = mods.effective.resolveEffectiveModels;
  mods.effective.resolveEffectiveModels = async (...a) => {
    order.push("model");
    return origModels(...a);
  };
  const origLimit = mods.limits.resolveEffectiveMonthlyLimit;
  mods.limits.resolveEffectiveMonthlyLimit = async (...a) => {
    order.push("limit");
    return origLimit(...a);
  };
  const origReserve = mods.quota.reserveUsage;
  mods.quota.reserveUsage = async (...a) => {
    order.push("reserve");
    return origReserve(...a);
  };
  const origDispatch = mods.quota.markDispatched;
  mods.quota.markDispatched = async (...a) => {
    order.push("dispatch");
    return origDispatch(...a);
  };
  mods.aiConnection.resolveActiveManagedKey = async () => {
    order.push("key");
    return Buffer.from(KEY_MATERIAL);
  };
  const seen = { calls: [] };
  await withFetch(
    providerOK([usageFrame(1, 1, "Hi"), DONE], seen),
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody({ messages: [{ role: "user", content: SENTINEL }] }));
        assert.equal(r.status, 200);
        await r.text();
        order.push("fetch-done");
      } finally {
        s.close();
      }
    }
  );
  // auth stub runs first by construction; validation is pure CPU first in
  // handler. NOTE: key resolution runs BEFORE the dispatch callback inside
  // the service — deliberate: a secret failure then leaves the reservation
  // RESERVED (never dispatched), so the zero-charge release path applies.
  // Invariant preserved: no key/provider before successful reservation.
  assert.deepEqual(order, [
    "validate",
    "mode",
    "access",
    "model",
    "limit",
    "reserve",
    "key",
    "dispatch",
    "fetch-done",
  ]);
  assert.equal(seen.calls[0].body.max_tokens, 4096);
  assertNoLeakState(fake._state, "order test");
});

test("reservation failure never touches key or provider", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { "schoolLimits/s1": { monthlyTokens: { student: 10, teacher: 10 } } });
  let keys = 0;
  mods.aiConnection.resolveActiveManagedKey = async () => {
    keys += 1;
    return Buffer.from(KEY_MATERIAL);
  };
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: { code: "MONTHLY_LIMIT_EXCEEDED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(keys, 0);
  assert.equal(seen.calls.length, 0);
});

test("secret failure before fetch follows zero-charge path", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => {
    const err = new Error("secret unavailable");
    err.code = "SECRET_UNAVAILABLE";
    throw err;
  };
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "r1");
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      // Headers already sent with the start event: failure arrives as a
      // safe SSE error event on HTTP 200, never raw provider detail.
      assert.equal(r.status, 200);
      const { text, events } = await readEvents(r);
      assert.deepEqual(
        events.filter((e) => e.event === "error").map((e) => e.data.code),
        ["AI_CONNECTION_UNAVAILABLE"]
      );
      assertNoLeakResponse(text, "secret failure");
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
  const doc = fake._state[`usageMonthly/${month}/reservations/${rid}`];
  assert.ok(doc, "reservation terminalized");
  assert.equal(doc.state, "failed");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [0, 0, 0, 0]);
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
  assert.equal(fake._state[`usageMonthly/${month}/schools/s1`], undefined);
  assertNoLeakState(fake._state, "secret failure");
});

test("failure before markDispatched releases zero", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const origDispatch = mods.quota.markDispatched;
  mods.quota.markDispatched = async () => {
    const err = new Error("quota store hiccup");
    err.code = "UNAVAILABLE";
    throw err;
  };
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "r1");
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 200);
      const { events } = await readEvents(r);
      // Phase 9B.2A: store-outage codes pass through the same safeCode
      // normalization as every other failure — raw UNAVAILABLE never
      // reaches the SSE wire. Accounting still took the zero-charge
      // release path (asserted below).
      assert.deepEqual(
        events.filter((e) => e.event === "error").map((e) => e.data.code),
        ["INTERNAL"]
      );
    } finally {
      s.close();
    }
  });
  mods.quota.markDispatched = origDispatch;
  assert.equal(seen.calls.length, 0);
  const doc = fake._state[`usageMonthly/${month}/reservations/${rid}`];
  assert.ok(doc);
  assert.equal(doc.state, "failed");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [0, 0, 0, 0]);
});

// ---------- Ambiguous network + explicit non-2xx (§18-19) ----------

test("ambiguous network failure after dispatch charges conservatively", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
  const expectedReserve = inUpper + Math.min(4096, 100000 - inUpper);
  await withFetch(
    async () => {
      seen.calls.push({});
      throw new TypeError("fetch failed");
    },
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody());
        assert.equal(r.status, 200);
        const { text, events } = await readEvents(r);
        assert.deepEqual(
          events.filter((e) => e.event === "error").map((e) => e.data.code),
          ["PROVIDER_UNAVAILABLE"]
        );
        assertNoLeakResponse(text, "ambiguity");
      } finally {
        s.close();
      }
    }
  );
  assert.equal(seen.calls.length, 1);
  const rid = ridHash("u1", "r1");
  assert.equal(fake._state[`usageMonthly/${month}/reservations/${rid}`].state, "failed");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.equal(user.conservativeChargedTokens, expectedReserve);
  assert.equal(user.requests, 1);
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
  const school = fake._state[`usageMonthly/${month}/schools/s1`];
  assert.equal(school.conservativeChargedTokens, expectedReserve);
  assert.equal(school.requests, 1);
});

test("explicit non-2xx policy: 401/403/429 zero-charge, 500 conservative", async () => {
  for (const [status, zeroCharge] of [[401, true], [403, true], [429, true], [500, false]]) {
    const { fake, buildManagedChatApp, mods } = boot({ user: USER });
    seedBaseline(fake._state);
    mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
    const seen = { calls: [] };
    const month = mods.quota.currentMonthIST();
    const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
    const expectedReserve = inUpper + Math.min(4096, 100000 - inUpper);
    const rid = ridHash("u1", `r-${status}`);
    const expectedCode = status === 429 ? "PROVIDER_RATE_LIMITED" : status === 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_AUTH_FAILED";
    await withFetch(providerStatus(status, seen), async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody({ requestId: `r-${status}` }));
        assert.equal(r.status, 200);
        const { text, events } = await readEvents(r);
        assert.deepEqual(
          events.filter((e) => e.event === "error").map((e) => e.data.code),
          [expectedCode],
          `status ${status}`
        );
        assertNoLeakResponse(text, `non-2xx ${status}`);
      } finally {
        s.close();
      }
    });
    assert.equal(seen.calls.length, 1);
    const doc = fake._state[`usageMonthly/${month}/reservations/${rid}`];
    assert.ok(doc, `reservation exists for ${status}`);
    assert.equal(doc.state, "failed");
    const user = fake._state[`usageMonthly/${month}/users/u1`];
    if (zeroCharge) {
      assert.deepEqual(
        [user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests],
        [0, 0, 0, 0],
        `status ${status} must be zero-charge`
      );
      assert.equal(fake._state[`usageMonthly/${month}/schools/s1`], undefined, `status ${status}: no analytics`);
    } else {
      assert.equal(user.conservativeChargedTokens, expectedReserve, `status ${status} must charge`);
      assert.equal(user.requests, 1);
    }
    assert.deepEqual(Object.keys(user.activeReservations || {}), []);
  }
});

// ---------- Success + markStarted outage (§20-22) ----------

test("2xx success commits exact usage with safe SSE", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  let text = "";
  await withFetch(providerOK([usageFrame(10, 5, "Hi"), frame({ choices: [{ delta: { content: " there" } }] }), DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody({ messages: [{ role: "user", content: SENTINEL }] }));
      assert.equal(r.status, 200);
      const { text: raw, events } = await readEvents(r);
      text = raw;
      assert.deepEqual(events.map((e) => e.event), ["start", "delta", "delta", "done"]);
      assert.equal(events[0].data.requestId, "r1");
    } finally {
      s.close();
    }
  });
  assertNoLeakResponse(text, "success");
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.calls[0].body.max_tokens, 4096);
  const rid = ridHash("u1", "r1");
  assert.equal(fake._state[`usageMonthly/${month}/reservations/${rid}`].state, "completed");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [10, 5, 0, 1]);
  assert.deepEqual(user.byModel["mdl_a"], { inputTokens: 10, outputTokens: 5, conservativeChargedTokens: 0, requests: 1 });
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
  const school = fake._state[`usageMonthly/${month}/schools/s1`];
  assert.deepEqual([school.inputTokens, school.outputTokens, school.requests], [10, 5, 1]);
  assertNoLeakState(fake._state, "success");
});

test("2xx + markStarted failure charges, never releases (mandatory)", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const origStarted = mods.quota.markStarted;
  let startedCalls = 0;
  mods.quota.markStarted = async () => {
    startedCalls += 1;
    const err = new Error("store down");
    err.code = "UNAVAILABLE";
    throw err;
  };
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
  const expectedReserve = inUpper + Math.min(4096, 100000 - inUpper);
  let text = "";
  await withFetch(providerOK([usageFrame(10, 5, "Hi"), DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 200);
      const parsed = await readEvents(r);
      text = parsed.text;
      assert.ok(parsed.events.some((e) => e.event === "error"), "client gets safe error, no answer streamed");
      assert.ok(!parsed.events.some((e) => e.event === "done"));
    } finally {
      s.close();
    }
  });
  mods.quota.markStarted = origStarted;
  assert.equal(startedCalls, 1);
  assert.equal(seen.calls.length, 1);
  assertNoLeakResponse(text, "markStarted outage");
  const rid = ridHash("u1", "r1");
  const doc = fake._state[`usageMonthly/${month}/reservations/${rid}`];
  assert.ok(["failed", "expired"].includes(doc.state), `terminal, got ${doc.state}`);
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.equal(user.conservativeChargedTokens, expectedReserve);
  assert.equal(user.requests, 1);
  assert.equal(user.inputTokens, 0);
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
});

test("markStarted + finalizer outage leaves recoverable dispatched state", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const origStarted = mods.quota.markStarted;
  const origFinalize = mods.quota.finalizeAcceptedUnknownUsage;
  const origCharge = mods.quota.finalizeStartedUnknownUsage;
  const outage = async () => {
    const err = new Error("store down");
    err.code = "UNAVAILABLE";
    throw err;
  };
  mods.quota.markStarted = outage;
  mods.quota.finalizeAcceptedUnknownUsage = outage;
  mods.quota.finalizeStartedUnknownUsage = outage;
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  await withFetch(providerOK([usageFrame(10, 5, "Hi"), DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 200);
      const { events } = await readEvents(r);
      // Phase 9B.1A: markStarted outage surfaces ACCOUNTING_UNAVAILABLE
      // (typed safe code) instead of the previous bare INTERNAL.
      assert.deepEqual(
        events.filter((e) => e.event === "error").map((e) => e.data.code),
        ["ACCOUNTING_UNAVAILABLE"]
      );
    } finally {
      s.close();
    }
  });
  mods.quota.markStarted = origStarted;
  mods.quota.finalizeAcceptedUnknownUsage = origFinalize;
  mods.quota.finalizeStartedUnknownUsage = origCharge;
  const rid = ridHash("u1", "r1");
  const doc = fake._state[`usageMonthly/${month}/reservations/${rid}`];
  assert.equal(doc.state, "dispatched", "durable risk state, never released");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.ok(user.activeReservations[rid], "active summary intact for stale recovery");
  assert.equal(user.conservativeChargedTokens, 0);
  // Later stale sweep charges it (simulate expiry + fresh request).
  user.activeReservations[rid].expiresAt = Date.now() - 1000;
  doc.expiresAt = Date.now() - 1000;
  const seen2 = { calls: [] };
  await withFetch(providerOK([usageFrame(1, 1, "Ok"), DONE], seen2), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody({ requestId: "r2" }));
      assert.equal(r.status, 200);
    } finally {
      s.close();
    }
  });
  assert.equal(fake._state[`usageMonthly/${month}/reservations/${rid}`].state, "expired");
  assert.ok(fake._state[upath(month, "u1")].conservativeChargedTokens > 0, "stale sweep charged");
});

function upath(month, uid) {
  return `usageMonthly/${month}/users/${uid}`;
}

// ---------- Stream outcomes: known/unknown usage, cancel, ceiling (§24-30) ----------

test("stream failure with known usage commits exact, not full charge", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  // Usage frame arrives, then transport dies mid-stream (delayed error so
  // the queued chunk drains first, like a real dying socket).
  await withFetch(
    async (url, init) => {
      seen.calls.push({});
      return { status: 200, headers: { get: () => "text/event-stream" }, body: failingBody(init, usageFrame(7, 3, "part"), new Error("socket reset")) };
    },
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody());
        assert.equal(r.status, 200);
        const { events } = await readEvents(r);
        assert.ok(events.some((e) => e.event === "error"));
      } finally {
        s.close();
      }
    }
  );
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [7, 3, 0, 1]);
  const rid = ridHash("u1", "r1");
  assert.equal(fake._state[`usageMonthly/${month}/reservations/${rid}`].state, "failed");
});

test("stream failure with unknown usage charges full reservation", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
  const expectedReserve = inUpper + Math.min(4096, 100000 - inUpper);
  await withFetch(
    async (url, init) => {
      seen.calls.push({});
      return {
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: failingBody(init, frame({ choices: [{ delta: { content: "part" } }] }), new Error("socket reset")),
      };
    },
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody());
        assert.equal(r.status, 200);
        // Consume the full body: res.end() happens only after finalization.
        const { events } = await readEvents(r);
        assert.ok(events.some((e) => e.event === "error"));
      } finally {
        s.close();
      }
    }
  );
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.equal(user.conservativeChargedTokens, expectedReserve);
  assert.equal(user.requests, 1);
  assert.equal(user.inputTokens, 0);
});

test("cancel with known partial usage commits exact", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  const ac = new AbortController();
  await withFetch(
    async (url, init) => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: hangingBody(init, usageFrame(6, 2, "partial")),
    }),
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const p = fetch(`http://127.0.0.1:${s.address().port}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chatBody()),
          signal: ac.signal,
        });
        // Wait for a delta event, then abort mid-stream. Receiving delta
        // proves the server already processed the usage frame (usage is
        // extracted before onDelta runs), so the abort cannot race it.
        const r = await p;
        const reader = r.body.getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          if (buf.includes("event: delta")) break;
        }
        ac.abort();
        try {
          await reader.read();
        } catch (_) {
          // Expected abort.
        }
      } finally {
        s.close();
      }
    }
  );
  const deadline = Date.now() + 3000;
  let user;
  for (;;) {
    user = fake._state[`usageMonthly/${month}/users/u1`];
    if (user && user.requests >= 1) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [6, 2, 0, 1]);
  const rid = ridHash("u1", "r1");
  assert.equal(fake._state[`usageMonthly/${month}/reservations/${rid}`].state, "cancelled");
});

test("cancel without usage charges full reservation", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
  const expectedReserve = inUpper + Math.min(4096, 100000 - inUpper);
  const ac = new AbortController();
  await withFetch(
    async (url, init) => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: hangingBody(init, frame({ choices: [{ delta: { content: "partial" } }] })),
    }),
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const p = fetch(`http://127.0.0.1:${s.address().port}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chatBody()),
          signal: ac.signal,
        });
        const r = await p;
        const reader = r.body.getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          if (buf.includes("event: delta")) break;
        }
        ac.abort();
        try {
          await reader.read();
        } catch (_) {
          // Expected abort.
        }
      } finally {
        s.close();
      }
    }
  );
  const deadline = Date.now() + 3000;
  let user;
  for (;;) {
    user = fake._state[`usageMonthly/${month}/users/u1`];
    if (user && user.requests >= 1) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(user.conservativeChargedTokens, expectedReserve);
  assert.equal(user.requests, 1);
  assert.equal(user.inputTokens, 0);
});

test("response ceiling: known usage commits exact, unknown charges", async () => {
  for (const withUsage of [true, false]) {
    const { fake, buildManagedChatApp, mods } = boot({ user: USER });
    seedBaseline(fake._state);
    mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
    const month = mods.quota.currentMonthIST();
    const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
    const expectedReserve = inUpper + Math.min(4096, 100000 - inUpper);
    const chunks = [];
    if (withUsage) chunks.push(usageFrame(11, 4, "ok"));
    chunks.push(frame({ choices: [{ delta: { content: "x".repeat(70000) } }] }));
    await withFetch(providerOK(chunks, { calls: [] }), async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody({ requestId: withUsage ? "rk" : "ru" }));
        assert.equal(r.status, 200);
        const { events } = await readEvents(r);
        assert.ok(events.some((e) => e.event === "error"), "ceiling surfaces safe error");
      } finally {
        s.close();
      }
    });
    const user = fake._state[`usageMonthly/${month}/users/u1`];
    if (withUsage) {
      assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens], [11, 4, 0]);
    } else {
      assert.equal(user.conservativeChargedTokens, expectedReserve);
    }
    assert.equal(user.requests, 1);
  }
});

test("actual usage beyond reservation commits in full", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  let text = "";
  await withFetch(providerOK([usageFrame(50000, 50000, "big"), DONE], { calls: [] }), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 200);
      text = await r.text();
    } finally {
      s.close();
    }
  });
  assertNoLeakResponse(text, "overage");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens], [50000, 50000]);
});

// ---------- Idempotency + concurrency (§32-35) ----------

test("duplicate active requestId returns 409 without second provider call", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  let releaseA = null;
  const gate = new Promise((resolve) => {
    releaseA = () => resolve();
  });
  await withFetch(
    async () => {
      seen.calls.push({});
      await gate;
      return { status: 200, headers: { get: () => "text/event-stream" }, body: sseBody([usageFrame(10, 5, "Hi"), DONE]) };
    },
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const pA = postChat(s.address().port, chatBody({ requestId: "dup" }));
        const deadline = Date.now() + 3000;
        for (; seen.calls.length < 1 && Date.now() < deadline;) {
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(seen.calls.length, 1);
        const rB = await postChat(s.address().port, chatBody({ requestId: "dup" }));
        assert.equal(rB.status, 409);
        assert.deepEqual(await rB.json(), { error: { code: "REQUEST_IN_PROGRESS" } });
        assert.equal(seen.calls.length, 1);
        releaseA();
        const rA = await pA;
        assert.equal(rA.status, 200);
        // Consume the full body: commit lands before res.end().
        await rA.text();
      } finally {
        s.close();
      }
    }
  );
  const month = mods.quota.currentMonthIST();
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.requests], [10, 5, 1]);
});

test("duplicate terminal requestId returns 409 without rerun or double charge", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  await withFetch(providerOK([usageFrame(10, 5, "Hi"), DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const rA = await postChat(s.address().port, chatBody({ requestId: "dup" }));
      assert.equal(rA.status, 200);
      await rA.text();
      const rB = await postChat(s.address().port, chatBody({ requestId: "dup" }));
      assert.equal(rB.status, 409);
      assert.deepEqual(await rB.json(), { error: { code: "REQUEST_ALREADY_PROCESSED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 1);
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.requests], [10, 5, 1]);
});

test("expired duplicate reconciles before refusal, no deferred cleanup", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "stale1");
  const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
  const expectedReserve = inUpper + Math.min(4096, 100000 - inUpper);
  fake._state[`usageMonthly/${month}/reservations/${rid}`] = {
    reservationId: rid,
    state: "dispatched",
    reservedTokens: expectedReserve,
    uid: "u1",
    schoolId: "s1",
    role: "student",
    modelKey: "mdl_a",
    requestId: "stale1",
    expiresAt: Date.now() - 1000,
  };
  fake._state[`usageMonthly/${month}/users/u1`] = {
    schemaVersion: 1,
    uid: "u1",
    period: month,
    inputTokens: 0,
    outputTokens: 0,
    conservativeChargedTokens: 0,
    requests: 0,
    activeReservations: {
      [rid]: { amount: expectedReserve, state: "dispatched", expiresAt: Date.now() - 1000, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
    byModel: {},
  };
  const seen = { calls: [] };
  await withFetch(providerOK([DONE], seen), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody({ requestId: "stale1" }));
      assert.equal(r.status, 409);
      assert.deepEqual(await r.json(), { error: { code: "REQUEST_ALREADY_PROCESSED" } });
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 0);
  assert.equal(fake._state[`usageMonthly/${month}/reservations/${rid}`].state, "expired");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.equal(user.conservativeChargedTokens, expectedReserve);
  assert.equal(user.requests, 1);
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
});

test("concurrent HTTP requests cannot overspend", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  const inUpper = mods.quota.estimateInputUpperBound([{ role: "user", content: "Hello" }], 0);
  const one = inUpper + Math.min(4096, 100000 - inUpper);
  seedBaseline(fake._state, { "schoolLimits/s1": { monthlyTokens: { student: one + inUpper - 1, teacher: 100000 } } });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  // Hold request A inside the provider call so request B must observe A's
  // live reservation: only one may fit, deterministically.
  let releaseA = null;
  const gate = new Promise((resolve) => {
    releaseA = () => resolve();
  });
  let bBody = "";
  await withFetch(
    async (url, init) => {
      seen.calls.push({ url, body: JSON.parse(init.body) });
      await gate;
      return { status: 200, headers: { get: () => "text/event-stream" }, body: sseBody([usageFrame(10, 5, "Hi"), DONE]) };
    },
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const pA = postChat(s.address().port, chatBody({ requestId: "c1" }));
        const deadline = Date.now() + 3000;
        for (; seen.calls.length < 1 && Date.now() < deadline;) {
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(seen.calls.length, 1);
        const rB = await postChat(s.address().port, chatBody({ requestId: "c2" }));
        assert.equal(rB.status, 403);
        bBody = await rB.text();
        assert.deepEqual(JSON.parse(bBody), { error: { code: "MONTHLY_LIMIT_EXCEEDED" } });
        releaseA();
        const rA = await pA;
        assert.equal(rA.status, 200);
        assertNoLeakResponse(await rA.text(), "concurrency-winner");
      } finally {
        s.close();
      }
    }
  );
  assert.equal(seen.calls.length, 1, "only the winner reaches the provider");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.requests], [10, 5, 1]);
  assertNoLeakResponse(bBody, "concurrency-loser");
});

// ---------- Independent allowances, model switch (§36-37) ----------

test("same-school users keep independent allowances", async () => {
  const shared = makeFakeSubiDb();
  seedBaseline(shared._state);
  const first = boot({ user: USER, store: shared });
  first.mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = first.mods.quota.currentMonthIST();
  await withFetch(providerOK([usageFrame(100, 50, "Hi"), DONE], { calls: [] }), async () => {
    const s = await listen(first.buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody());
      assert.equal(r.status, 200);
      await r.text();
    } finally {
      s.close();
    }
  });
  assert.equal(shared._state[`usageMonthly/${month}/users/u1`].inputTokens, 100);
  const second = boot({ user: { uid: "u2", schoolId: "s1", role: "student", accountType: "school" }, store: shared });
  second.mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(providerOK([usageFrame(7, 3, "Hi"), DONE], { calls: [] }), async () => {
    const s = await listen(second.buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody({ requestId: "r2" }));
      assert.equal(r.status, 200, "u2 allowance independent of u1 consumption");
    } finally {
      s.close();
    }
  });
  // GET /managed/usage lives on the managed app (not the chat function).
  const s2 = await listen(second.buildManagedApp());
  try {
    const usage = await (await fetch(`http://127.0.0.1:${s2.address().port}/managed/usage`)).json();
    assert.deepEqual([usage.allowed, usage.usage.usedTokens, usage.usage.remainingTokens], [true, 10, 100000 - 10]);
  } finally {
    s2.close();
  }
});

test("model switch accumulates one UID total", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  fake._state["approvedModels/mdl_b"] = {
    modelKey: "mdl_b",
    displayName: "Model B",
    upstreamModelId: "vendor/b",
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
    contextLength: 8192,
  };
  fake._state["schoolModelPolicies/s1"] = {
    roles: { student: { modelKeys: ["mdl_a", "mdl_b"] }, teacher: { modelKeys: ["mdl_a", "mdl_b"] } },
  };
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  await withFetch(providerOK([usageFrame(10, 5, "A"), DONE], { calls: [] }), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody({ requestId: "m1" }));
      assert.equal(r.status, 200);
      await r.text();
    } finally {
      s.close();
    }
  });
  await withFetch(providerOK([usageFrame(20, 10, "B"), DONE], { calls: [] }), async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const r = await postChat(s.address().port, chatBody({ requestId: "m2", modelKey: "mdl_b" }));
      assert.equal(r.status, 200);
      await r.text();
    } finally {
      s.close();
    }
  });
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.requests], [30, 15, 2]);
  assert.deepEqual(Object.keys(user.byModel).sort(), ["mdl_a", "mdl_b"]);
});

// ---------- GET /managed/usage views (§38-42) ----------

async function authedGetUsage(port) {
  const r = await fetch(`http://127.0.0.1:${port}/managed/usage`);
  assert.equal(r.status, 200);
  return r.json();
}

test("GET usage reflects exact commit and conservative charge", async () => {
  const { fake, buildManagedApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  const month = mods.quota.currentMonthIST();
  const before = await (async () => {
    const s = await listen(buildManagedApp());
    try {
      return await authedGetUsage(s.address().port);
    } finally {
      s.close();
    }
  })();
  assert.deepEqual(before, {
    allowed: true,
    quotaMode: "school_tokens",
    usage: { configured: true, period: month, monthlyTokenLimit: 100000, usedTokens: 0, remainingTokens: 100000 },
    // Phase 9B.2A: capability rides along (seedBaseline mode is enabled).
    chatAvailable: true,
  });
  seedBaseline(fake._state);
  fake._state[`usageMonthly/${month}/users/u1`] = {
    schemaVersion: 1, uid: "u1", period: month,
    inputTokens: 40000, outputTokens: 15000, conservativeChargedTokens: 5000, requests: 3,
    activeReservations: {}, byModel: {},
  };
  const s = await listen(buildManagedApp());
  try {
    const after = await authedGetUsage(s.address().port);
    assert.equal(after.usage.usedTokens, 60000);
    assert.equal(after.usage.remainingTokens, 40000);
  } finally {
    s.close();
  }
});

test("GET usage subtracts live active, ignores expired-reserved, counts expired-risk", async () => {
  const { fake, buildManagedApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  const month = mods.quota.currentMonthIST();
  const live = Date.now() + 600000;
  const past = Date.now() - 1000;
  fake._state[`usageMonthly/${month}/users/u1`] = {
    schemaVersion: 1, uid: "u1", period: month,
    inputTokens: 10000, outputTokens: 0, conservativeChargedTokens: 0, requests: 1,
    activeReservations: {
      liveR: { amount: 4000, state: "reserved", expiresAt: live, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      deadR: { amount: 9000, state: "reserved", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      deadD: { amount: 3000, state: "dispatched", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      deadS: { amount: 2000, state: "started", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
    byModel: {},
  };
  const s = await listen(buildManagedApp());
  try {
    const out = await authedGetUsage(s.address().port);
    // used = 10000 + 3000 + 2000 (expired risk counted); active = 4000 (expired reserved ignored).
    assert.equal(out.usage.usedTokens, 15000);
    assert.equal(out.usage.remainingTokens, 100000 - 15000 - 4000);
  } finally {
    s.close();
  }
  // Read-only: expired entries untouched by the view.
  assert.equal(fake._state[`usageMonthly/${month}/users/u1`].activeReservations.deadD.state, "dispatched");
});

// ---------- Admin config routes (§48-50) ----------

test("admin config: 401 unauthenticated, 403 non-admin", async () => {
  const noAuth = boot({});
  const s = await listen(noAuth.buildAdminApp());
  try {
    const port = s.address().port;
    const g = await fetch(`http://127.0.0.1:${port}/admin/managed-chat-config`);
    assert.equal(g.status, 401);
    const p = await fetch(`http://127.0.0.1:${port}/admin/managed-chat-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "enabled" }),
    });
    assert.equal(p.status, 401);
  } finally {
    s.close();
  }
  const teacher = boot({ user: { uid: "t1", schoolId: "s1", role: "teacher" } });
  const s2 = await listen(teacher.buildAdminApp());
  try {
    const port = s2.address().port;
    const g = await fetch(`http://127.0.0.1:${port}/admin/managed-chat-config`);
    assert.equal(g.status, 403);
    const p = await fetch(`http://127.0.0.1:${port}/admin/managed-chat-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "enabled" }),
    });
    assert.equal(p.status, 403);
  } finally {
    s2.close();
  }
});

test("admin config: superadmin GET/POST, validation, audit, write target", async () => {
  const { fake, buildAdminApp } = boot({ user: ADMIN });
  const s = await listen(buildAdminApp());
  try {
    const port = s.address().port;
    const g0 = await (await fetch(`http://127.0.0.1:${port}/admin/managed-chat-config`)).json();
    assert.equal(g0.mode, "disabled");
    const post = async (body) =>
      fetch(`http://127.0.0.1:${port}/admin/managed-chat-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const bad of [
      { mode: "sometimes" },
      { mode: "test", testUids: Array.from({ length: 11 }, (_, i) => `u${i}`) },
      { mode: "test", extra: 1 },
      { mode: "test", testUids: [], updatedAt: "2000-01-01", updatedBy: "mallory" },
      { testUids: [] },
    ]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.deepEqual(await r.json(), { error: { code: "INVALID_REQUEST" } });
    }
    const ok = await post({ mode: "test", testUids: ["u1", "u2"] });
    assert.equal(ok.status, 200);
    const saved = await ok.json();
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "test");
    assert.deepEqual(saved.testUids, ["u1", "u2"]);
    assert.ok(typeof saved.updatedAt === "string" && saved.updatedAt.length > 0);
    assert.equal(saved.updatedBy, "admin1");
    const g1 = await (await fetch(`http://127.0.0.1:${port}/admin/managed-chat-config`)).json();
    assert.equal(g1.mode, "test");
    assert.deepEqual(g1.testUids, ["u1", "u2"]);
  } finally {
    s.close();
  }
  // Audit written safely; config confined to named subi path.
  const audits = Object.entries(fake._state).filter(([k]) => k.startsWith("auditLogs/"));
  assert.equal(audits.length, 1);
  const entry = audits[0][1];
  assert.equal(entry.action, "managed_chat_config.updated");
  assert.equal(entry.adminUid, "admin1");
  assert.ok(!JSON.stringify(entry).match(/sk-|secret|prompt/i), "audit must stay safe");
  assert.ok(fake._state["systemConfig/managedChat"], "config doc exists");
  assert.equal(fake._state["systemConfig/managedChat"].mode, "test");
  for (const k of Object.keys(fake._state)) {
    assert.ok(
      k.startsWith("systemConfig/") || k.startsWith("auditLogs/"),
      `unexpected write target ${k}`
    );
  }
  assertNoLeakState(fake._state, "admin config");
});

// ---------- Phase 9B.2C: dispatch-failure diagnostics (no behavior change) ----------

function captureStageLogs() {
  // Must run AFTER boot(): boot clears the src require cache, so this grabs
  // the same logger instance the app graph uses.
  const log = require("../src/utils/structuredLogger");
  const events = [];
  log._setLoggerForTests({
    info: (d) => events.push(d),
    warn: (d) => events.push(d),
    error: (d) => events.push(d),
    debug: () => {},
    log: () => {},
  });
  return { log, events };
}

async function runDispatchFailure({ code, message, extra, markDomain }) {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const origDispatch = mods.quota.markDispatched;
  mods.quota.markDispatched = async () => {
    const err = new Error(message);
    err.code = code;
    if (extra) Object.assign(err, extra);
    if (markDomain) err.isSubiDomainError = true;
    throw err;
  };
  let started = 0;
  const origStarted = mods.quota.markStarted;
  mods.quota.markStarted = (...a) => {
    started += 1;
    return origStarted(...a);
  };
  const { log, events } = captureStageLogs();
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "r1");
  let wire;
  try {
    await withFetch(providerOK([DONE], seen), async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody());
        assert.equal(r.status, 200);
        wire = await readEvents(r);
      } finally {
        s.close();
      }
    });
  } finally {
    mods.quota.markDispatched = origDispatch;
    mods.quota.markStarted = origStarted;
    log._resetLoggerForTests();
  }
  return { fake, mods, month, rid, seen, started, events, wire };
}

function assertDispatchRelease(outcome, expectedClass, expectedWireCode = "INTERNAL") {
  const { fake, month, rid, seen, started, events, wire } = outcome;
  assert.equal(seen.calls.length, 0, "provider fetch must never run");
  assert.equal(started, 0, "markStarted must never run");
  assert.deepEqual(
    wire.events.filter((e) => e.event === "error").map((e) => e.data.code),
    [expectedWireCode],
    "client keeps the safe normalized code"
  );
  const stageEvents = events.filter((e) => e && e.action === "managed-chat-stage-failure");
  assert.equal(stageEvents.length, 1, "exactly one stage diagnostic");
  const ev = stageEvents[0];
  assert.equal(ev.stage, "mark_dispatched");
  assert.equal(ev.storeCodeClass, expectedClass);
  assert.ok(typeof ev.requestIdHash === "string" && ev.requestIdHash.length === 32);
  assert.notEqual(ev.requestIdHash, "r1", "raw requestId must not be logged");
  assert.equal(ev.modelKey, "mdl_a");
  assert.equal(ev.period, month);
  assert.ok(typeof ev.reservationId === "string" && ev.reservationId.length > 0);
  assert.ok(typeof ev.durationMs === "number");
  const doc = fake._state[`usageMonthly/${month}/reservations/${rid}`];
  assert.ok(doc, "reservation terminalized");
  assert.equal(doc.state, "failed");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual(
    [user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests],
    [0, 0, 0, 0],
    "zero-charge release preserved"
  );
  assert.deepEqual(Object.keys(user.activeReservations || {}), [], "no live entries left");
  assertNoLeakState(fake._state, `dispatch ${expectedClass}`);
  return ev;
}

test("9B.2C dispatch UNAVAILABLE: diagnostic class, no fetch, release, INTERNAL wire", async () => {
  const outcome = await runDispatchFailure({ code: "UNAVAILABLE", message: "quota store hiccup" });
  assertDispatchRelease(outcome, "UNAVAILABLE");
  assertNoLeakResponse(outcome.wire.text, "dispatch unavailable");
});

test("9B.2C dispatch ABORTED: diagnostic class, no fetch, release, INTERNAL wire", async () => {
  const outcome = await runDispatchFailure({ code: "ABORTED", message: "transaction aborted" });
  assertDispatchRelease(outcome, "ABORTED");
});

test("9B.2C dispatch DEADLINE_EXCEEDED: diagnostic class, no fetch, release, INTERNAL wire", async () => {
  const outcome = await runDispatchFailure({ code: "deadline-exceeded", message: "too slow" });
  assertDispatchRelease(outcome, "DEADLINE_EXCEEDED");
});

test("9B.2C dispatch unknown store error: class UNKNOWN, nothing hostile logged", async () => {
  const outcome = await runDispatchFailure({
    code: "WEIRD_FUTURE_7",
    message: "hostile Bearer sk-test prompt upstreamModelId secret payload content",
    extra: {
      stack: "Error: hostile stack Bearer abc\n    at evil (x.js:1:1)",
      custom: { nested: "prompt text completion delta" },
    },
  });
  assertDispatchRelease(outcome, "UNKNOWN");
  const dump = JSON.stringify(outcome.events);
  for (const banned of [
    "Bearer ",
    "sk-test",
    "upstreamModelId",
    "hostile",
    "WEIRD_FUTURE_7",
    "prompt",
    "secret",
    "payload",
    "completion",
    "delta",
  ]) {
    assert.equal(dump.includes(banned), false, `diagnostic leaked ${banned}`);
  }
  assertNoLeakResponse(outcome.wire.text, "dispatch unknown");
});

// ---------- Phase 9B.2F: error-origin dimension (no behavior change) ----------

function stageEventOf(outcome) {
  const found = outcome.events.filter((e) => e && e.action === "managed-chat-stage-failure");
  assert.equal(found.length, 1, "exactly one stage diagnostic");
  return found[0];
}

test("9B.2F dispatch domain INVALID_REQUEST: origin domain, release unchanged", async () => {
  const outcome = await runDispatchFailure({
    code: "INVALID_REQUEST",
    message: "reservation owner mismatch",
    markDomain: true,
  });
  // Listed domain codes pass safeCode normalization through to the wire.
  assertDispatchRelease(outcome, "UNKNOWN", "INVALID_REQUEST");
  const ev = stageEventOf(outcome);
  assert.equal(ev.errorOrigin, "domain");
  assert.equal(ev.domainCodeClass, "INVALID_REQUEST");
  assertNoLeakResponse(outcome.wire.text, "dispatch domain invalid");
});

test("9B.2F dispatch domain duplicate terminal: origin domain", async () => {
  const outcome = await runDispatchFailure({
    code: "REQUEST_ALREADY_PROCESSED",
    message: "request already processed",
    markDomain: true,
  });
  assertDispatchRelease(outcome, "UNKNOWN", "REQUEST_ALREADY_PROCESSED");
  const ev = stageEventOf(outcome);
  assert.equal(ev.errorOrigin, "domain");
  assert.equal(ev.domainCodeClass, "REQUEST_ALREADY_PROCESSED");
});

test("9B.2F dispatch raw permission-denied: origin store, no domain class", async () => {
  const outcome = await runDispatchFailure({ code: "permission-denied", message: "denied" });
  assertDispatchRelease(outcome, "UNKNOWN");
  const ev = stageEventOf(outcome);
  assert.equal(ev.errorOrigin, "store");
  assert.ok(!("domainCodeClass" in ev), "store origin must not carry a domain class");
});

test("9B.2F dispatch numeric not-found: origin store", async () => {
  const outcome = await runDispatchFailure({ code: 5, message: "missing" });
  assertDispatchRelease(outcome, "UNKNOWN");
  const ev = stageEventOf(outcome);
  assert.equal(ev.errorOrigin, "store");
  assert.ok(!("domainCodeClass" in ev), "store origin must not carry a domain class");
});

test("9B.2F dispatch hostile unknown: origin unknown, no domain class, no leak", async () => {
  const outcome = await runDispatchFailure({
    code: "totally-weird-code",
    message: "SECRET TOKEN PROMPT hostile payload",
    extra: {
      stack: "Error: hostile Bearer xyz\n    at evil (x.js:1:1)",
      custom: { nested: "completion text" },
    },
  });
  assertDispatchRelease(outcome, "UNKNOWN");
  const ev = stageEventOf(outcome);
  assert.equal(ev.errorOrigin, "unknown");
  assert.ok(!("domainCodeClass" in ev), "unknown origin must not carry a domain class");
  const dump = JSON.stringify(outcome.events);
  for (const banned of ["Bearer ", "SECRET", "TOKEN", "PROMPT", "hostile", "payload", "completion", "totally-weird-code"]) {
    assert.equal(dump.includes(banned), false, `diagnostic leaked ${banned}`);
  }
});

// ---------- Phase 9B.2I: codeType/errorKind/dispatchPhase (no behavior change) ----------

test("9B.2I dispatch TypeError: missing code, type_error, release, INTERNAL wire", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const origDispatch = mods.quota.markDispatched;
  mods.quota.markDispatched = async () => {
    throw new TypeError("HOSTILE SECRET PROMPT TOKEN");
  };
  const { log, events } = captureStageLogs();
  const seen = { calls: [] };
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "r1");
  try {
    await withFetch(providerOK([DONE], seen), async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody());
        assert.equal(r.status, 200);
        const { text, events: sse } = await readEvents(r);
        assert.deepEqual(
          sse.filter((e) => e.event === "error").map((e) => e.data.code),
          ["INTERNAL"]
        );
        assertNoLeakResponse(text, "dispatch typeerror");
      } finally {
        s.close();
      }
    });
  } finally {
    mods.quota.markDispatched = origDispatch;
    log._resetLoggerForTests();
  }
  assert.equal(seen.calls.length, 0);
  const found = events.filter((e) => e && e.action === "managed-chat-stage-failure");
  assert.equal(found.length, 1);
  const ev = found[0];
  assert.equal(ev.stage, "mark_dispatched");
  assert.equal(ev.storeCodeClass, "UNKNOWN");
  assert.equal(ev.errorOrigin, "unknown");
  assert.equal(ev.codeType, "missing");
  assert.equal(ev.errorKind, "type_error");
  assert.equal(ev.dispatchPhase, "unknown");
  const dump = JSON.stringify(events);
  for (const banned of ["HOSTILE", "SECRET", "PROMPT", "TOKEN"]) {
    assert.equal(dump.includes(banned), false, `diagnostic leaked ${banned}`);
  }
  const doc = fake._state[`usageMonthly/${month}/reservations/${rid}`];
  assert.ok(doc && doc.state === "failed");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [0, 0, 0, 0]);
});

test("9B.2I dispatch unknown string code: codeType string, origin unknown", async () => {
  const outcome = await runDispatchFailure({ code: "some-unrecognized-string", message: "mystery" });
  assertDispatchRelease(outcome, "UNKNOWN");
  const ev = stageEventOf(outcome);
  assert.equal(ev.codeType, "string");
  assert.equal(ev.errorOrigin, "unknown");
  assert.ok(!("domainCodeClass" in ev));
  assert.equal(ev.dispatchPhase, "unknown");
  assert.ok(!JSON.stringify(outcome.events).includes("some-unrecognized-string"));
});

test("9B.2I dispatch hostile object code: codeType other, nothing serialized", async () => {
  const outcome = await runDispatchFailure({
    code: { nested: "HOSTILE SECRET OBJECT CODE" },
    message: "object-coded failure",
  });
  assertDispatchRelease(outcome, "UNKNOWN");
  const ev = stageEventOf(outcome);
  assert.equal(ev.codeType, "other");
  assert.equal(ev.errorOrigin, "unknown");
  const dump = JSON.stringify(outcome.events);
  assert.ok(!dump.includes("HOSTILE"), "object code must never serialize");
});

test("9B.2I real dispatch with failing second read surfaces reservation_write_queued", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  // Real production markDispatched against a store whose SECOND read fails:
  // replicates the SDK read-after-write shape with zero behavior change.
  const realDispatch = mods.quota.markDispatched;
  let gets = 0;
  const throwingStore = {
    collection: (name) => ({
      doc: (id) => ({
        _key: `${name}/${id}`,
        collection: (sub) => ({ doc: (subId) => ({ _key: `${name}/${id}/${sub}/${subId}` }) }),
      }),
    }),
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          gets += 1;
          if (gets >= 2) throw new Error("boom-second-read");
          const key = ref._key;
          if (key.endsWith(`/reservations/${ridHash("u1", "r1")}`)) {
            return {
              exists: true,
              data: () => ({
                reservationId: ridHash("u1", "r1"),
                uid: "u1",
                period: mods.quota.currentMonthIST(),
                requestId: "r1",
                modelKey: "mdl_a",
                schoolId: "s1",
                role: "student",
                state: "reserved",
              }),
            };
          }
          return { exists: false, data: () => undefined };
        },
        set() {},
      };
      return fn(tx);
    },
  };
  mods.quota.markDispatched = (args) => realDispatch(args, { store: throwingStore });
  const { log, events } = captureStageLogs();
  const seen = { calls: [] };
  try {
    await withFetch(providerOK([DONE], seen), async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const r = await postChat(s.address().port, chatBody());
        assert.equal(r.status, 200);
        const { events: sse } = await readEvents(r);
        assert.deepEqual(
          sse.filter((e) => e.event === "error").map((e) => e.data.code),
          ["INTERNAL"]
        );
      } finally {
        s.close();
      }
    });
  } finally {
    mods.quota.markDispatched = realDispatch;
    log._resetLoggerForTests();
  }
  assert.equal(seen.calls.length, 0);
  const found = events.filter((e) => e && e.action === "managed-chat-stage-failure");
  assert.equal(found.length, 1);
  const ev = found[0];
  // Phase 9B.2J: both reads precede all writes, so the injected user-read
  // failure surfaces with the last completed checkpoint.
  assert.equal(ev.dispatchPhase, "reservation_read");
  assert.equal(ev.codeType, "missing");
  assert.equal(ev.errorKind, "generic_error");
  assert.equal(ev.errorOrigin, "unknown");
  assert.equal(ev.storeCodeClass, "UNKNOWN");
});

// ---------- Phase 9B.2A: capability, safe normalization, socket-close ----------

const http = require("http");

// Raw SSE client: destroys its own socket once `until(accumulatedText)` is
// true, then resolves with what was received. Models a client disconnect.
function sseDestroyClient(port, body, until) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (!settled) {
        settled = true;
        resolve(out);
      }
    };
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/chat",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          if (until(buf)) {
            try {
              res.destroy();
            } catch (_) {
              // best-effort only
            }
            try {
              req.destroy();
            } catch (_) {
              // best-effort only
            }
            finish({ status: res.statusCode, text: buf, destroyed: true });
          }
        });
        res.on("end", () => finish({ status: res.statusCode, text: buf }));
        res.on("close", () => finish({ status: res.statusCode, text: buf }));
      }
    );
    req.on("error", () => finish({ status: -1, text: "" }));
    req.end(payload);
  });
}

async function pollState(cond, what, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    const hit = cond();
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function terminalDoc(fake, month, rid) {
  const d = fake._state[`usageMonthly/${month}/reservations/${rid}`];
  return d && (d.state === "cancelled" || d.state === "failed" || d.state === "completed") ? d : null;
}

test("9B.2A socket destroyed mid-upload reserves nothing", async () => {
  const { fake, buildManagedChatApp } = boot({ user: USER });
  seedBaseline(fake._state);
  const s = await listen(buildManagedChatApp());
  try {
    await new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: s.address().port,
          path: "/chat",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": 5000 },
        },
        () => {}
      );
      req.on("error", () => resolve());
      req.write('{"requestId":"r1",');
      setTimeout(() => {
        try {
          req.destroy();
        } catch (_) {
          // best-effort only
        }
        resolve();
      }, 100);
    });
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    s.close();
  }
  // The handler never ran: no reservation, no usage, no leak.
  assert.deepEqual(
    Object.keys(fake._state).filter((k) => k.startsWith("usageMonthly/")),
    []
  );
  assertNoLeakState(fake._state, "mid-upload destroy");
});

test("9B.2A disconnect while provider hangs charges conservatively", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "r1");
  const seen = { calls: [] };
  // Hung upstream that honors abort like undici: dispatch already happened,
  // acceptance never will. Per policy this is post-dispatch ambiguity and
  // must charge, never release.
  const hangingFetch = async (url, init) => {
    seen.calls.push({ url });
    await new Promise((_, reject) => {
      const sig = init && init.signal;
      const abortErr = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (!sig) return;
      if (sig.aborted) {
        abortErr();
        return;
      }
      sig.addEventListener("abort", abortErr, { once: true });
    });
  };
  await withFetch(hangingFetch, async () => {
    const s = await listen(buildManagedChatApp());
    try {
      const out = await sseDestroyClient(s.address().port, chatBody(), (t) => t.includes("event: start"));
      assert.equal(out.status, 200);
      assert.ok(out.destroyed, "client destroyed after start");
      assert.ok(!out.text.includes("event: delta"), "no answer text reached the client");
    } finally {
      s.close();
    }
  });
  assert.equal(seen.calls.length, 1);
  const doc = await pollState(() => terminalDoc(fake, month, rid), "conservative terminal");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  assert.equal(user.conservativeChargedTokens, doc.reservedTokens);
  assert.deepEqual([user.inputTokens, user.outputTokens, user.requests], [0, 0, 1]);
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
  assertNoLeakState(fake._state, "hang disconnect");
});

test("9B.2A disconnect after provider accept charges without usage", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "r1");
  const seen = { calls: [] };
  await withFetch(
    async (url, init) => {
      seen.calls.push({ url });
      return { status: 200, headers: { get: () => "text/event-stream" }, body: hangingBody(init) };
    },
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const out = await sseDestroyClient(s.address().port, chatBody(), (t) => t.includes("event: start"));
        assert.equal(out.status, 200);
        assert.ok(out.destroyed, "client destroyed after start");
      } finally {
        s.close();
      }
    }
  );
  assert.equal(seen.calls.length, 1);
  const doc = await pollState(() => terminalDoc(fake, month, rid), "accepted terminal");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  // Accepted but usage unknown: full conservative charge, exact counters zero.
  assert.equal(user.conservativeChargedTokens, doc.reservedTokens);
  assert.deepEqual([user.inputTokens, user.outputTokens, user.requests], [0, 0, 1]);
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
  assertNoLeakState(fake._state, "accept disconnect");
});

test("9B.2A disconnect after partial delta commits exact usage", async () => {
  const { fake, buildManagedChatApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const month = mods.quota.currentMonthIST();
  const rid = ridHash("u1", "r1");
  await withFetch(
    // One delta+usage frame, then hang: the body honors abort like undici,
    // otherwise the server could never observe the client disconnect.
    async (url, init) => ({
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: hangingBody(init, usageFrame(10, 5, "Hi")),
    }),
    async () => {
      const s = await listen(buildManagedChatApp());
      try {
        const out = await sseDestroyClient(s.address().port, chatBody(), (t) => t.includes("event: delta"));
        assert.equal(out.status, 200);
        assert.ok(out.destroyed, "client destroyed after first delta");
      } finally {
        s.close();
      }
    }
  );
  const doc = await pollState(() => terminalDoc(fake, month, rid), "partial terminal");
  assert.equal(doc.state, "cancelled");
  const user = fake._state[`usageMonthly/${month}/users/u1`];
  // Known partial usage commits exactly; no conservative charge.
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [10, 5, 0, 1]);
  assert.deepEqual(Object.keys(user.activeReservations || {}), []);
  assertNoLeakState(fake._state, "partial disconnect");
});

// ---------- Phase 9B.2A: user-safe chat capability on GET /managed/usage ----------

async function getUsageRaw(port) {
  const r = await fetch(`http://127.0.0.1:${port}/managed/usage`);
  assert.equal(r.status, 200);
  return { text: await r.text(), json: null };
}

test("9B.2A capability across modes: disabled/test/enabled/missing/malformed", async () => {
  const cases = [
    [{ mode: "disabled", testUids: [] }, false, "disabled"],
    [{ mode: "test", testUids: ["u1"] }, true, "test-allowed"],
    [{ mode: "enabled", testUids: [] }, true, "enabled"],
    [null, false, "missing"],
    [{ mode: "sometimes", testUids: [] }, false, "malformed"],
  ];
  for (const [config, expected, label] of cases) {
    const booted = boot({ user: USER });
    seedBaseline(booted.fake._state);
    if (config === null) {
      delete booted.fake._state["systemConfig/managedChat"];
    } else {
      booted.fake._state["systemConfig/managedChat"] = config;
    }
    const s = await listen(booted.buildManagedApp());
    try {
      const { text } = await getUsageRaw(s.address().port);
      const body = JSON.parse(text);
      assert.equal(body.chatAvailable, expected, `capability ${label}`);
      assert.equal(body.allowed, true, `access still allowed (${label})`);
      assert.ok(body.usage && body.usage.configured === true, `usage preserved (${label})`);
      assertNoLeakResponse(text, `capability ${label}`);
      assert.ok(!text.includes("testUids"), `no testUids leak (${label})`);
      assert.ok(!text.includes('"uid"'), `no uid leak (${label})`);
    } finally {
      s.close();
    }
  }
});

test("9B.2A capability is per-user: listed teacher true, unlisted student false", async () => {
  // Share one fake subi DB across boots (same pattern as the per-UID
  // isolation test above): the store object must be a real fake with
  // .collection(), never a bare object.
  const first = boot({ user: { uid: "t1", schoolId: "s1", role: "teacher", accountType: "school" } });
  seedBaseline(first.fake._state, { "systemConfig/managedChat": { mode: "test", testUids: ["t1"] } });
  const s = await listen(first.buildManagedApp());
  try {
    const body = JSON.parse((await getUsageRaw(s.address().port)).text);
    assert.equal(body.chatAvailable, true, "listed teacher can send");
  } finally {
    s.close();
  }
  const other = boot({ user: { uid: "u9", schoolId: "s1", role: "student", accountType: "school" }, store: first.fake });
  const s2 = await listen(other.buildManagedApp());
  try {
    const { text } = await getUsageRaw(s2.address().port);
    const body = JSON.parse(text);
    assert.equal(body.chatAvailable, false, "unlisted student cannot send");
    assertNoLeakResponse(text, "capability per-user");
    assert.ok(!text.includes("testUids"), "no testUids leak");
  } finally {
    s2.close();
  }
});

test("9B.2A denied user hides usage and reports chatAvailable false", async () => {
  const booted = boot({ user: USER });
  seedBaseline(booted.fake._state, { "systemConfig/subiAccess": { enabled: false } });
  const s = await listen(booted.buildManagedApp());
  try {
    const { text } = await getUsageRaw(s.address().port);
    assert.deepEqual(JSON.parse(text), {
      allowed: false,
      code: "SUBI_ACCESS_DISABLED",
      chatAvailable: false,
    });
    assertNoLeakResponse(text, "denied usage");
  } finally {
    s.close();
  }
});

test("9B.2A zero limit keeps configured true; capability stays mode-driven", async () => {
  const booted = boot({ user: USER });
  seedBaseline(booted.fake._state, { "schoolLimits/s1": { monthlyTokens: { student: 0, teacher: 0 } } });
  const s = await listen(booted.buildManagedApp());
  try {
    const { text } = await getUsageRaw(s.address().port);
    const body = JSON.parse(text);
    // Quota arithmetic untouched: configured stays true, remaining is zero.
    assert.equal(body.usage.configured, true);
    assert.equal(body.usage.monthlyTokenLimit, 0);
    assert.equal(body.usage.remainingTokens, 0);
    // Capability reflects server mode only (enabled here); the extension
    // combines it with quota. No conflation on either side.
    assert.equal(body.chatAvailable, true);
    assertNoLeakResponse(text, "zero limit");
  } finally {
    s.close();
  }
});

// ---------- Phase 9B.3B.1: usage capability diagnostic (contract unchanged) ----------

function captureUsageLogs() {
  // Must run AFTER boot(): boot clears the src require cache, so this grabs
  // the same logger instance the app graph uses.
  const log = require("../src/utils/structuredLogger");
  const events = [];
  log._setLoggerForTests({
    info: (d) => events.push(d),
    warn: (d) => events.push(d),
    error: (d) => events.push(d),
    debug: () => {},
    log: () => {},
  });
  return { log, events };
}

function capabilityEvents(events) {
  return events.filter((e) => e && e.action === "managed-usage-capability-evaluated");
}

async function usageWithLogs(port) {
  const r = await fetch(`http://127.0.0.1:${port}/managed/usage`);
  assert.equal(r.status, 200);
  const text = await r.text();
  return { text, body: JSON.parse(text) };
}

test("9B.3B.1 capability match logs test/1/true without identities", async () => {
  const { fake, buildManagedApp } = boot({ user: USER });
  seedBaseline(fake._state, { "systemConfig/managedChat": { mode: "test", testUids: ["u1"] } });
  const { log, events } = captureUsageLogs();
  const s = await listen(buildManagedApp());
  try {
    const { text, body } = await usageWithLogs(s.address().port);
    assert.equal(body.chatAvailable, true);
    assert.equal(body.usage.configured, true);
    const found = capabilityEvents(events);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], {
      action: "managed-usage-capability-evaluated",
      chatModeClass: "test",
      testUidCount: 1,
      testUidMatched: true,
      chatAvailable: true,
      accessAllowed: true,
      usageConfigured: true,
      roleClass: "student",
    });
    assertNoLeakResponse(text, "capability match");
    assert.ok(!text.includes("testUids"), "no testUids in response");
  } finally {
    s.close();
    log._resetLoggerForTests();
  }
});

test("9B.3B.1 capability mismatch logs false without identities", async () => {
  const { fake, buildManagedApp } = boot({ user: USER });
  seedBaseline(fake._state, { "systemConfig/managedChat": { mode: "test", testUids: ["someone-else-uid"] } });
  const { log, events } = captureUsageLogs();
  const s = await listen(buildManagedApp());
  try {
    const { text, body } = await usageWithLogs(s.address().port);
    assert.equal(body.chatAvailable, false);
    const found = capabilityEvents(events);
    assert.equal(found.length, 1);
    assert.equal(found[0].chatModeClass, "test");
    assert.equal(found[0].testUidCount, 1);
    assert.equal(found[0].testUidMatched, false);
    assert.equal(found[0].chatAvailable, false);
    const dump = JSON.stringify(events);
    for (const banned of ["someone-else-uid", "\"u1\""]) {
      assert.equal(dump.includes(banned), false, `diagnostic leaked ${banned}`);
    }
  } finally {
    s.close();
    log._resetLoggerForTests();
  }
});

test("9B.3B.1 capability disabled and enabled branches", async () => {
  for (const [mode, expectedAvailable] of [["disabled", false], ["enabled", true]]) {
    const { fake, buildManagedApp } = boot({ user: USER });
    seedBaseline(fake._state, { "systemConfig/managedChat": { mode, testUids: [] } });
    const { log, events } = captureUsageLogs();
    const s = await listen(buildManagedApp());
    try {
      const { body } = await usageWithLogs(s.address().port);
      assert.equal(body.chatAvailable, expectedAvailable, `mode ${mode}`);
      const found = capabilityEvents(events);
      assert.equal(found.length, 1);
      assert.equal(found[0].chatModeClass, mode);
      assert.equal(found[0].testUidMatched, false);
    } finally {
      s.close();
      log._resetLoggerForTests();
    }
  }
});

test("9B.3B.1 capability leak test with hostile identifiers", async () => {
  const hostileUid = "attacker-uid-zz hostile";
  const hostileListed = ["uid-sk-hostile-1", "evil@example.test"];
  const { fake, buildManagedApp } = boot({ user: { uid: hostileUid, schoolId: "s1", role: "student", accountType: "school" } });
  seedBaseline(fake._state, { "systemConfig/managedChat": { mode: "test", testUids: hostileListed } });
  const { log, events } = captureUsageLogs();
  const s = await listen(buildManagedApp());
  try {
    const { text, body } = await usageWithLogs(s.address().port);
    assert.equal(body.chatAvailable, false);
    const found = capabilityEvents(events);
    assert.equal(found.length, 1);
    assert.equal(found[0].testUidCount, 2);
    assert.equal(found[0].testUidMatched, false);
    const dump = JSON.stringify(events);
    for (const banned of ["attacker-uid-zz", "uid-sk-hostile-1", "evil@example.test", "hostile"]) {
      assert.equal(dump.includes(banned), false, `diagnostic leaked ${banned}`);
    }
    assertNoLeakResponse(text, "capability hostile");
  } finally {
    s.close();
    log._resetLoggerForTests();
  }
});
