// test/managedAgentRoute.test.js — Phase 13 hotfix: POST /agent/turn route
// integration with fake OpenRouter fetch. Exercises the REAL agent route
// (auth stub, fake subi Firestore, stubbed key resolver) for: text-only
// success + usage finalize, provider 401/404/429 classification,
// unsupported-model and build rejection without provider calls, system-role
// rejection, and idempotent replay without double charge.
// No real provider. No production Firestore. No deploys. No real secrets.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const { writeDoc } = require("./orderingTx");

function makeFakeSubiDb({ failCreditFlagsRead = false } = {}) {
  const state = {};
  const reads = [];
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      return {
        _key: key,
        async get() {
          reads.push(key);
          if (failCreditFlagsRead && key === "systemConfig/individualCreditFlags") {
            throw new Error("credit flags unavailable");
          }
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
    _reads: reads,
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
    exports: { admin: {}, learnsmartDb: require('./orderingTx').orderingStore(), subiDb: fake },
  };
  const authMod = require("../src/middleware/auth");
  authMod.requireAuth = () => (req, res, next) => {
    if (!user) return res.status(401).json({ error: "Missing auth token" });
    req.subi = { ...user };
    next();
  };
  // A successful school auth fixture represents existing typed directory
  // records. Individual/missing-record scenarios override these explicitly.
  if (user?.accountType === 'school') {
    const directory = require("../src/services/learnsmartDirectoryService");
    directory.getUserProfile = async () => ({ ...user, status: 'active', subscription: null });
    directory.getSchool = async id => id === user.schoolId ? { id, accountType: 'school', subscription: null } : null;
  }
  if (profile !== undefined) {
    require("../src/services/learnsmartDirectoryService").getUserProfile = async () => profile;
  }
  if (school !== undefined || schoolReadError) {
    require("../src/services/learnsmartDirectoryService").getSchool = async () => {
      if (schoolReadError) throw new Error("school directory unavailable");
      return school;
    };
  }
  const app = require("../src/app");
  return {
    fake,
    buildManagedApp: app.buildManagedApp,
    buildManagedAgentApp: app.buildManagedAgentApp,
    mods: {
      aiConnection: require("../src/services/aiConnectionService"),
      quota: require("../src/services/usageQuotaService"),
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";

function providerSse(chunks) {
  const text = chunks.join("") + DONE;
  return new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(text));
      c.close();
    },
  });
}

function textChunk(content, finish) {
  return frame({ choices: [{ delta: { content }, finish_reason: finish || null }] });
}

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

const USER = { uid: "u1", schoolId: "s1", role: "student", accountType: "school" };
const UPSTREAM = "vendor/model-agent-a";
const KEY_MATERIAL = "sk-test-managed-key-xyz";

function seedBaseline(st, over = {}) {
  st["systemConfig/managedAgent"] = { mode: "enabled", testUids: [] };
  st["systemConfig/subiAccess"] = { enabled: true };
  st["schoolPolicies/s1"] = { roles: { student: { enabled: true }, teacher: { enabled: true } } };
  st["approvedModels/mdl_a"] = {
    modelKey: "mdl_a",
    displayName: "Model A",
    upstreamModelId: UPSTREAM,
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 8192,
  };
  st["approvedModels/mdl_plain"] = {
    modelKey: "mdl_plain",
    displayName: "Plain Model",
    upstreamModelId: UPSTREAM,
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
    contextLength: 8192,
  };
  st["schoolModelPolicies/s1"] = {
    roles: { student: { modelKeys: ["mdl_a", "mdl_plain"] }, teacher: { modelKeys: ["mdl_a"] } },
  };
  st["schoolLimits/s1"] = { monthlyTokens: { student: 100000, teacher: 100000 } };
  Object.assign(st, over);
}

function agentBody(over = {}) {
  return {
    protocolVersion: 1,
    modelKey: "mdl_a",
    agentMode: "ask",
    clientRunId: "run-1",
    providerRequestIndex: 0,
    canonicalTurns: [{ role: "user", content: "hi" }],
    toolCapabilityVersion: "read_v1",
    ...over,
  };
}

async function postTurn(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .filter((b) => b.trim().length > 0)
    .map((b) => {
      const lines = b.split("\n");
      const ev = (lines.find((l) => l.startsWith("event:")) || "").slice(6).trim();
      const dataLine = lines.find((l) => l.startsWith("data:")) || "";
      return { event: ev, data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : null };
    });
}

const BANNED = [UPSTREAM, KEY_MATERIAL, "testUids", "reservationId", "_key", "stack", "Error:"];

for (const accountType of ['school', 'individual']) test(`native ${accountType} tools settle through the existing gateway and replay never redispatches`, async () => {
  const oldFlag = process.env.SUBI_NATIVE_AGENT_ENABLED;
  process.env.SUBI_NATIVE_AGENT_ENABLED = '1';
  const user = { ...USER, uid: `native-${accountType}`, accountType };
  const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
  const { fake, buildManagedAgentApp, mods } = boot({ user, profile });
  seedBaseline(fake._state, {
    'systemConfig/managedAgent': { mode: 'enabled', terminalEnabled: true },
    'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true },
  });
  fake._state['approvedModels/mdl_a'].capabilities.agentVerify = 'verified';
  fake._state['approvedModels/mdl_a'].pricing = { input: '0.000010', output: '0.000050' };
  if (accountType === 'individual') seedCurrentWallet(fake._state, profile);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let dispatches = 0;
  const body = agentBody({ agentMode: 'build', toolCapabilityVersion: 'agent_v3', canonicalTurns: undefined,
    nativeRequest: { messages: [{ role: 'user', content: 'Read the file.' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] } });
  await withFetch(async (_url, init) => {
    dispatches++;
    const request = JSON.parse(init.body);
    assert.equal(request.model, UPSTREAM);
    assert.equal(request.tools[0].function.name, 'read');
    assert.match(request.messages[0].content, /Subi Code/);
    return { status: 200, body: providerSse([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_native', type: 'function', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }] }, finish_reason: 'tool_calls' }] }),
      frame({ usage: { prompt_tokens: 50, completion_tokens: 7 } }),
    ]) };
  }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const first = await postTurn(server.address().port, body);
      assert.equal(first.status, 200, first.text);
      const chunks = first.text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, 'call_native');
      assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'read');
      assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 });
      assert.ok(first.text.endsWith('data: [DONE]\n\n'));
      assertNoLeak(first.text, 'native success');
      const state = JSON.stringify(fake._state);
      const replay = await postTurn(server.address().port, body);
      assert.notEqual(replay.status, 200, replay.text);
      assert.equal(JSON.stringify(fake._state), state);
      assert.equal(dispatches, 1);
    } finally { server.close(); }
  });
  if (oldFlag === undefined) delete process.env.SUBI_NATIVE_AGENT_ENABLED; else process.env.SUBI_NATIVE_AGENT_ENABLED = oldFlag;
});

test('native gateway is disabled by default and rejects before any provider dispatch', async () => {
  const flag = process.env.SUBI_NATIVE_AGENT_ENABLED;
  delete process.env.SUBI_NATIVE_AGENT_ENABLED;
  const { fake, buildManagedAgentApp } = boot({ user: USER });
  seedBaseline(fake._state);
  const server = await listen(buildManagedAgentApp());
  try {
    const denied = await postTurn(server.address().port, { nativeRequest: {} });
    assert.equal(denied.status, 503);
    assert.equal(JSON.parse(denied.text).error.code, 'MANAGED_AGENT_DISABLED');
    assert.equal(Object.keys(fake._state).some(key => key.startsWith('usageMonthly/')), false);
  } finally {
    server.close();
    if (flag === undefined) delete process.env.SUBI_NATIVE_AGENT_ENABLED; else process.env.SUBI_NATIVE_AGENT_ENABLED = flag;
  }
});

for (const accountType of ['school', 'individual']) for (const denied of ['access', 'model', 'quota']) test(`native ${accountType} cannot bypass ${denied} authority`, async () => {
  const flag = process.env.SUBI_NATIVE_AGENT_ENABLED;
  process.env.SUBI_NATIVE_AGENT_ENABLED = '1';
  const user = { ...USER, uid: `native-denied-${accountType}`, accountType };
  const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
  const { fake, buildManagedAgentApp } = boot({ user, profile });
  seedBaseline(fake._state, { 'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true } });
  fake._state['approvedModels/mdl_a'].pricing = { input: '0.000010', output: '0.000050' };
  if (accountType === 'individual') seedCurrentWallet(fake._state, profile);
  if (denied === 'access') fake._state['systemConfig/subiAccess'].enabled = false;
  if (denied === 'model') fake._state['approvedModels/mdl_a'].enabled = false;
  if (denied === 'quota') {
    if (accountType === 'school') fake._state['schoolLimits/s1'].monthlyTokens.student = 0;
    else Object.assign(fake._state[`creditAccounts/${user.uid}`], { monthlyRemainingCreditsMilli: 0, rolloverRemainingCreditsMilli: 0, topupRemainingCreditsMilli: 0 });
  }
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('native authority bypass'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody({ canonicalTurns: undefined, toolCapabilityVersion: 'inspect_v1', nativeRequest: { messages: [{ role: 'user', content: 'Inspect.' }] } }));
      assert.equal(result.status, accountType === 'individual' && denied === 'quota' ? 402 : 403, result.text);
      const code = JSON.parse(result.text).error.code;
      assert.equal(code, denied === 'access' ? 'SUBI_ACCESS_DISABLED' : denied === 'model' ? 'MODEL_NOT_ALLOWED' : accountType === 'individual' ? 'INSUFFICIENT_CREDITS' : 'MONTHLY_LIMIT_EXCEEDED');
      assert.equal(dispatches, 0);
    } finally { server.close(); }
  });
  if (flag === undefined) delete process.env.SUBI_NATIVE_AGENT_ENABLED; else process.env.SUBI_NATIVE_AGENT_ENABLED = flag;
});

test('native stateless completion uses the same accounting and honors the smaller host output budget', async () => {
  const flag = process.env.SUBI_NATIVE_AGENT_ENABLED;
  process.env.SUBI_NATIVE_AGENT_ENABLED = '1';
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async (_url, init) => {
    assert.equal(JSON.parse(init.body).max_tokens, 32);
    return { status: 200, body: providerSse([textChunk('Native completion', 'stop'), frame({ usage: { prompt_tokens: 50, completion_tokens: 7 } })]) };
  }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/agent/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', 'x-opencode-session': 'stateless-session' },
        body: JSON.stringify({ model: 'mdl_a', stream: false, messages: [{ role: 'user', content: 'Reply once.' }], max_tokens: 32 }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const body = await response.json();
      assert.equal(body.choices[0].message.content, 'Native completion');
      assert.equal(body.model, 'mdl_a');
      assert.deepEqual(body.usage, { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 });
      assertNoLeak(JSON.stringify(body), 'native stateless');
      const usage = fake._state[`usageMonthly/${mods.quota.currentMonthIST()}/users/${USER.uid}`];
      assert.equal(usage.inputTokens, 50);
    } finally { server.close(); }
  });
  if (flag === undefined) delete process.env.SUBI_NATIVE_AGENT_ENABLED; else process.env.SUBI_NATIVE_AGENT_ENABLED = flag;
});

test('native stalled-provider cancellation settles the dispatched hold and replay never resumes it', { timeout: 10_000 }, async () => {
  const flag = process.env.SUBI_NATIVE_AGENT_ENABLED;
  process.env.SUBI_NATIVE_AGENT_ENABLED = '1';
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let started, settled;
  const dispatch = new Promise(resolve => { started = resolve; });
  const final = new Promise(resolve => { settled = resolve; });
  const finalize = mods.quota.finalizeStartedUnknownUsage;
  mods.quota.finalizeStartedUnknownUsage = async input => { const result = await finalize(input); settled(); return result; };
  let calls = 0;
  const body = agentBody({ canonicalTurns: undefined, toolCapabilityVersion: 'inspect_v1', nativeRequest: { messages: [{ role: 'user', content: 'Inspect safely.' }] } });
  await withFetch(async (_url, init) => {
    calls++; started();
    return new Promise((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error('fixture cancellation'), { name: 'AbortError' }));
      if (init.signal.aborted) stop(); else init.signal.addEventListener('abort', stop, { once: true });
    });
  }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${server.address().port}/agent/turn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify(body), signal: controller.signal,
      }).then(result => result.text()).catch(() => 'aborted');
      await dispatch;
      controller.abort();
      await response;
      await final;
      const usage = fake._state[`usageMonthly/${mods.quota.currentMonthIST()}/users/${USER.uid}`];
      assert.ok(usage.conservativeChargedTokens > 0);
      assert.equal(usage.inputTokens + usage.outputTokens, 0, 'unknown usage must not be reported as actual provider tokens');
      assert.deepEqual(usage.activeReservations, {});
      const replay = await postTurn(server.address().port, body);
      assert.equal(replay.status, 409, replay.text);
      assert.equal(calls, 1);
    } finally { server.closeAllConnections(); server.close(); }
  });
  if (flag === undefined) delete process.env.SUBI_NATIVE_AGENT_ENABLED; else process.env.SUBI_NATIVE_AGENT_ENABLED = flag;
});
function assertNoLeak(text, what) {
  for (const banned of BANNED) {
    assert.equal(text.includes(banned), false, `${what}: response leaks ${banned}`);
  }
}

test('managed answer-only PLAN repair reaches the provider without tools and settles real route usage', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let dispatched = 0;
  await withFetch(async (_url, init) => {
    const request = JSON.parse(init.body);
    dispatched++;
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.match(request.messages[0].content, /no tools are available/i);
    return { status: 200, body: providerSse([textChunk('```task-plan\n{"title":"Plan","goal":"Inspect","steps":[]}\n```','stop'),
      frame({usage:{prompt_tokens:50,completion_tokens:7}})]) };
  }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody({agentMode:'plan',answerOnly:true}));
      assert.equal(result.status, 200);
      assert.ok(parseSse(result.text).some(event => event.event === 'done'));
      assertNoLeak(result.text, 'answer-only repair');
    } finally { server.close(); }
  });
  assert.equal(dispatched, 1);
  const usage = fake._state[`usageMonthly/${mods.quota.currentMonthIST()}/users/u1`];
  assert.equal(usage.inputTokens, 50);
  assert.deepEqual(usage.activeReservations, {});
});

test("route text-only success: textDelta + done, exact usage finalized, no leak", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerCalls = 0;
  await withFetch(async () => {
    providerCalls += 1;
    return {
      status: 200,
      body: providerSse([
        textChunk("Hello", null),
        frame({ choices: [{ finish_reason: "stop" }] }),
        frame({ usage: { prompt_tokens: 50, completion_tokens: 7 } }),
      ]),
    };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const { status, text } = await postTurn(s.address().port, agentBody());
      assert.equal(status, 200);
      const events = parseSse(text);
      assert.equal(events[0].event, "start");
      const deltas = events.filter((e) => e.event === "textDelta").map((e) => e.data.text).join("");
      assert.equal(deltas, "Hello");
      assert.ok(events.some((e) => e.event === "done"));
      assert.deepEqual(events.find((e)=>e.event==='done').data.usage,{inputTokens:50,outputTokens:7});
      assertNoLeak(text, "agent success");
    } finally {
      s.close();
    }
  });
  assert.equal(providerCalls, 1);
  const period = mods.quota.currentMonthIST();
  const userDoc = fake._state[`usageMonthly/${period}/users/u1`];
  assert.ok(userDoc, "usage doc exists");
  assert.equal(userDoc.inputTokens, 50);
  assert.equal(userDoc.outputTokens, 7);
  assert.deepEqual(userDoc.activeReservations, {});
});

test('route sends images and file text only for an assigned image-capable model', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER }); seedBaseline(fake._state);
  fake._state['approvedModels/mdl_a'].capabilities.inputModalities.push('image');
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  require('../src/services/modelCatalogService').fetchCatalog = async () => ({ models: [{ upstreamModelId: UPSTREAM, contextLength: 8192, capabilities: { inputModalities: ['text', 'image'] } }] });
  const reserve = mods.quota.reserveUsage;
  mods.quota.reserveUsage = async (params) => {
    assert.equal(params.inputUpperBound, 8192, 'image input must reserve the verified provider context ceiling, not encoded upload bytes');
    return reserve(params);
  };
  const image = { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
  let providerCalls = 0;
  await withFetch(async (_url, init) => {
    providerCalls += 1; const request = JSON.parse(init.body);
    assert.deepEqual(request.messages[1].content, [{ type: 'text', text: 'Inspect attached project file: const a = 1;' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.base64}` } }]);
    return { status: 200, body: providerSse([textChunk('Image received', 'stop'), frame({ usage: { prompt_tokens: 50, completion_tokens: 7 } })]) };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({ canonicalTurns: [{ role: 'user', content: 'Inspect attached project file: const a = 1;', images: [image] }] }));
      assert.equal(result.status, 200); assert.ok(parseSse(result.text).some(e => e.event === 'done')); assertNoLeak(result.text, 'image request');
      assert.equal(result.text.includes(image.base64), false);
    } finally { s.close(); }
  });
  assert.equal(providerCalls, 1);
  assert.equal(JSON.stringify(fake._state).includes(image.base64), false, 'image bytes must not enter quota storage');
  const settled = fake._state[`usageMonthly/${mods.quota.currentMonthIST()}/users/u1`];
  assert.equal(settled.inputTokens, 50); assert.equal(settled.outputTokens, 7);
  assert.deepEqual(settled.activeReservations, {}, 'unused ceiling reservation is released after exact settlement');
});

test('image disconnect during cold catalog lookup never reserves or dispatches', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER }); seedBaseline(fake._state);
  fake._state['approvedModels/mdl_a'].capabilities.inputModalities.push('image');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  require('../src/services/modelCatalogService').fetchCatalog = async () => { entered(); await wait; return { models: [{ upstreamModelId: UPSTREAM, contextLength: 8192, capabilities: { inputModalities: ['image'] } }] }; };
  let calls = 0; mods.quota.reserveUsage = async () => { calls++; throw new Error('cancelled'); };
  await withFetch(async () => { calls++; throw new Error('cancelled'); }, async () => {
    const server = await listen(buildManagedAgentApp()); const controller = new AbortController();
    const closed = new Promise(resolve => server.once('connection', socket => socket.once('close', resolve)));
    const request = fetch(`http://127.0.0.1:${server.address().port}/agent/turn`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify(agentBody({ canonicalTurns: [{ role: 'user', content: 'Inspect', images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] }] })) }).catch(() => undefined);
    try {
      await started; controller.abort(); await request; await closed; release();
      await new Promise(setImmediate);
      assert.equal(calls, 0);
    } finally { release(); server.closeAllConnections(); server.close(); }
  });
});

test('image ceiling cannot bypass insufficient monthly allowance', async () => {
  const { fake, buildManagedAgentApp } = boot({ user: USER }); seedBaseline(fake._state);
  fake._state['approvedModels/mdl_a'].capabilities.inputModalities.push('image');
  fake._state['schoolLimits/s1'].monthlyTokens.student = 1000;
  require('../src/services/modelCatalogService').fetchCatalog = async () => ({ models: [{ upstreamModelId: UPSTREAM, contextLength: 8192, capabilities: { inputModalities: ['image'] } }] });
  let calls = 0;
  await withFetch(async () => { calls++; throw new Error('must not dispatch'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody({ canonicalTurns: [{ role: 'user', content: 'Inspect', images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] }] }));
      assert.equal(result.status, 403); assert.equal(JSON.parse(result.text).error.code, 'MONTHLY_LIMIT_EXCEEDED');
    } finally { server.close(); }
  });
  assert.equal(calls, 0);
});

test('image quota denies missing provider ceiling before reservation and dispatch', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER }); seedBaseline(fake._state);
  fake._state['approvedModels/mdl_a'].capabilities.inputModalities.push('image');
  require('../src/services/modelCatalogService').fetchCatalog = async () => ({ models: [{ upstreamModelId: UPSTREAM, contextLength: null }] });
  let calls = 0;
  mods.quota.reserveUsage = async () => { calls++; throw new Error('must not reserve without a safe image bound'); };
  await withFetch(async () => { calls++; throw new Error('must not dispatch'); }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({ canonicalTurns: [{ role: 'user', content: 'Inspect', images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] }] }));
      assert.equal(result.status, 403); assert.equal(JSON.parse(result.text).error.code, 'IMAGE_INPUT_UNAVAILABLE');
    } finally { s.close(); }
  });
  assert.equal(calls, 0);
});

test('text-only model rejects images before provider and quota dispatch', async () => {
  const { fake, buildManagedAgentApp } = boot({ user: USER }); seedBaseline(fake._state);
  let calls = 0;
  await withFetch(async () => { calls += 1; throw new Error('must not dispatch'); }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({ canonicalTurns: [{ role: 'user', content: 'Inspect', images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] }] }));
      assert.equal(result.status, 403); assert.equal(JSON.parse(result.text).error.code, 'IMAGE_INPUT_UNAVAILABLE');
    } finally { s.close(); }
  });
  assert.equal(calls, 0); assert.equal(Object.keys(fake._state).some(k => k.startsWith('usageMonthly/')), false);
});

test("route provider 401 surfaces PROVIDER_AUTH_FAILED without leak", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async () => ({ status: 401, body: null }), async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const { status, text } = await postTurn(s.address().port, agentBody());
      assert.equal(status, 200);
      const events = parseSse(text);
      const err = events.find((e) => e.event === "error");
      assert.ok(err, "SSE error frame present");
      assert.equal(err.data.code, "PROVIDER_AUTH_FAILED");
      assertNoLeak(text, "auth failure");
    } finally {
      s.close();
    }
  });
});

test("route provider 404 surfaces MODEL_NOT_AVAILABLE (stale mapping)", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async () => ({ status: 404, body: null }), async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const { status, text } = await postTurn(s.address().port, agentBody());
      assert.equal(status, 200);
      const events = parseSse(text);
      const err = events.find((e) => e.event === "error");
      assert.ok(err, "SSE error frame present");
      assert.equal(err.data.code, "MODEL_NOT_AVAILABLE");
      assertNoLeak(text, "model unavailable");
    } finally {
      s.close();
    }
  });
});

test("route provider 429 surfaces PROVIDER_RATE_LIMITED", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async () => ({ status: 429, body: null, headers: new Headers({ "retry-after": "3600" }) }), async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const { status, text } = await postTurn(s.address().port, agentBody());
      assert.equal(status, 200);
      const events = parseSse(text);
      const err = events.find((e) => e.event === "error");
      assert.ok(err, "SSE error frame present");
      assert.equal(err.data.code, "PROVIDER_RATE_LIMITED");
      assert.equal(err.data.retryAfterMs, 3600000);
    } finally {
      s.close();
    }
  });
});

test("route rejects non-tool-capable model without provider call", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerCalls = 0;
  await withFetch(async () => {
    providerCalls += 1;
    return { status: 200, body: providerSse([textChunk("x", "stop")]) };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/agent/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify(agentBody({ modelKey: "mdl_plain" })),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error.code, "AGENT_UNSUPPORTED_MODEL");
    } finally {
      s.close();
    }
  });
  assert.equal(providerCalls, 0);
});

test("route rejects build mode and system roles without provider calls", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerCalls = 0;
  await withFetch(async () => {
    providerCalls += 1;
    return { status: 200, body: providerSse([textChunk("x", "stop")]) };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      for (const body of [
        agentBody({ agentMode: "build" }),
        agentBody({ canonicalTurns: [{ role: "system", content: "pwn" }, { role: "user", content: "hi" }] }),
      ]) {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/agent/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 400);
        const parsed = await res.json();
        assert.equal(parsed.error.code, "INVALID_REQUEST");
      }
    } finally {
      s.close();
    }
  });
  assert.equal(providerCalls, 0);
});

test("route file_v1/build is test-UID gated before provider dispatch", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerCalls = 0;
  await withFetch(async () => {
    providerCalls += 1;
    return { status: 200, body: providerSse([textChunk("x", "stop")]) };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const denied = await postTurn(s.address().port, agentBody({
        agentMode: "build",
        toolCapabilityVersion: "file_v1",
      }));
      assert.equal(denied.status, 403);
      assert.equal(JSON.parse(denied.text).error.code, "AGENT_BUILD_LOCKED");
    } finally {
      s.close();
    }
  });
  assert.equal(providerCalls, 0);
});

test("test-UID build request receives exact file_v2 provider schemas", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [USER.uid] },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerBody;
  await withFetch(async (_url, init) => {
    providerBody = JSON.parse(init.body);
    return {
      status: 200,
      body: providerSse([
        textChunk("Ready", null),
        frame({ choices: [{ finish_reason: "stop" }] }),
        frame({ usage: { prompt_tokens: 20, completion_tokens: 3 } }),
      ]),
    };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({
        agentMode: "build",
        toolCapabilityVersion: "file_v2",
      }));
      assert.equal(result.status, 200);
      assert.ok(parseSse(result.text).some((event) => event.event === "done"));
    } finally {
      s.close();
    }
  });
  assert.deepEqual(providerBody.tools.map((d) => d.function.name), [
    "get_workspace_info",
    "find_files",
    "search_text",
    "read_file",
    "propose_patch",
    "apply_patch",
    "undo_change",
  ]);
  const propose = providerBody.tools.find((d) => d.function.name === "propose_patch");
  assert.ok(propose.function.parameters.properties.oldString);
  assert.ok(propose.function.parameters.properties.newString);
  assert.deepEqual(propose.function.parameters.required, []);
});

test("access-status exposes build capability only to entitled test UID", async () => {
  const { fake, buildManagedApp } = boot({ user: USER });
  seedBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [USER.uid] },
  });
  const s = await listen(buildManagedApp());
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/managed/access-status`, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const { permissionPolicy, ...existing } = body;
    assert.deepEqual(existing, { allowed: true, accountType: "school", quotaMode: "school_tokens", agentAvailable: true, agentFile: "build", agentImage: 'image_v1', agentMcp: 'mcp_v1', toolCapabilities: ['agent_skills_v1'] });
    assert.equal(permissionPolicy.profileCeiling, 'ask');
    assert.equal(permissionPolicy.source, 'school_role');
    assert.ok(permissionPolicy.validUntilMs > Date.now());
  } finally {
    s.close();
  }
});
test('a free-only fallback whose registry price changed is refused before reservation or provider dispatch', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  fake._state['approvedModels/mdl_a'].upstreamModelId = 'test/model:free';
  fake._state['approvedModels/mdl_a'].pricing = { input: '0', output: '0.00001' };
  mods.aiConnection.resolveActiveManagedKey = async () => { throw Error('must not resolve a key'); };
  const server = await listen(buildManagedAgentApp());
  try {
    const result = await postTurn(server.address().port, agentBody({ freeModelOnly: true }));
    assert.equal(JSON.parse(result.text).error.code, 'MODEL_NOT_AVAILABLE');
    assert.equal(Object.keys(fake._state).some(key => key.startsWith('usageMonthly/')), false);
  } finally { server.close(); }
});
test('a registry mapping change during free fallback admission cannot dispatch the earlier model', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER }); seedBaseline(fake._state);
  fake._state['approvedModels/mdl_a'].upstreamModelId = 'test/original:free';
  fake._state['approvedModels/mdl_a'].pricing = { input: '0', output: '0' };
  const resolver = require('../src/services/effectiveModelService'), original = resolver.resolveUpstreamModelId;
  resolver.resolveUpstreamModelId = async key => { const model = await original(key); fake._state['approvedModels/mdl_a'].upstreamModelId = 'test/changed:free'; return model; };
  mods.aiConnection.resolveActiveManagedKey = async () => { throw Error('must not resolve a key'); };
  const server = await listen(buildManagedAgentApp());
  try { const result = await postTurn(server.address().port, agentBody({ freeModelOnly: true })); assert.equal(JSON.parse(result.text).error.code, 'MODEL_NOT_AVAILABLE'); }
  finally { server.close(); }
});
for (const accountType of ['school', 'individual']) test(`shared free cooldown prevents ${accountType} provider dispatch and releases its allowance`, async () => {
  const user = { ...USER, accountType };
  const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
  const { fake, buildManagedAgentApp, mods } = boot({ user, profile });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'enabled' }, 'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true } });
  fake._state['approvedModels/mdl_a'].upstreamModelId = 'test/model:free';
  fake._state['approvedModels/mdl_a'].pricing = { input: '0', output: '0' };
  fake._state['managedProviderCapacity/openrouter-free'] = { cooldownUntilMs: Date.now() + 3600000 };
  if (accountType === 'individual') seedCurrentWallet(fake._state, profile);
  const before = accountType === 'individual' ? fake._state[`creditAccounts/${user.uid}`].monthlyRemainingCreditsMilli : 0;
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw Error('provider must not be called'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody());
      const frame = parseSse(result.text).find(item => item.event === 'error');
      assert.equal(frame?.data?.code, 'PROVIDER_RATE_LIMITED', result.text);
      assert.ok(frame.data.retryAfterMs > 3500000);
      assert.equal(dispatches, 0);
      if (accountType === 'individual') {
        assert.equal(fake._state[`creditAccounts/${user.uid}`].monthlyRemainingCreditsMilli, before);
        assert.equal(fake._state[`creditAccounts/${user.uid}`].reservedCreditsMilli, 0);
      } else {
        const monthly = Object.entries(fake._state).filter(([key]) => key.startsWith('usageMonthly/'));
        assert.equal(monthly.some(([, data]) => data.tokensUsed > 0 || data.tokensReserved > 0), false);
      }
    } finally { server.close(); }
  });
});

test('access-status reports an unlisted agent as unavailable while preserving account admission', async () => {
  const { fake, buildManagedApp } = boot({ user: USER });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: ['other'], terminalEnabled: true } });
  const server = await listen(buildManagedApp());
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
    const body = await response.json();
    assert.equal(body.allowed, true);
    assert.equal(body.agentAvailable, false);
    assert.equal(body.agentFile, undefined);
    assert.equal(body.agentTerminal, undefined);
    assert.equal(body.testUids, undefined);
  } finally { server.close(); }
});

test('access-status mirrors the existing full-capability route flag after the operational gate', async () => {
  const { fake, buildManagedApp } = boot({ user: USER });
  seedBaseline(fake._state, {
    'systemConfig/managedAgent': { mode: 'enabled', testUids: [], terminalEnabled: true },
    'systemConfig/individualCreditFlags': { fullAgentCapabilitiesEnabled: true },
  });
  const server = await listen(buildManagedApp());
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
    const body = await response.json();
    assert.equal(body.agentAvailable, true);
    assert.equal(body.agentFile, 'build');
    assert.equal(body.agentTerminal, 'terminal');
  } finally { server.close(); }
});

// Jobs negotiation is a separate, server-authoritative field. The existing
// skills capability array stays unchanged, and checking access has no quota
// side effects. An old or forged cached jobs field cannot bypass /agent/turn.
for (const accountType of ['school', 'individual']) {
  for (const scenario of [
    { name: 'production jobs enabled', config: { mode: 'enabled', jobsEnabled: true }, available: true, jobs: true },
    { name: 'production jobs disabled', config: { mode: 'enabled', jobsEnabled: false }, available: true },
    { name: 'production jobs missing', config: { mode: 'enabled' }, available: true },
    { name: 'production jobs malformed', config: { mode: 'enabled', jobsEnabled: 'true' }, available: true },
    { name: 'production qualification identity listed', config: { mode: 'enabled', jobsEnabled: false, jobsTestUids: [USER.uid] }, available: true, jobs: true },
    { name: 'production qualification identity unlisted', config: { mode: 'enabled', jobsEnabled: false, jobsTestUids: ['other'] }, available: true },
    { name: 'production qualification list malformed', config: { mode: 'enabled', jobsEnabled: false, jobsTestUids: [USER.uid, null] }, available: true },
    { name: 'disabled agent ignores qualification identity', config: { mode: 'disabled', jobsTestUids: [USER.uid] }, available: false },
    { name: 'test agent qualification identity not in main allowlist', config: { mode: 'test', testUids: ['other'], jobsTestUids: [USER.uid] }, available: false },
    { name: 'agent disabled despite jobs switch', config: { mode: 'disabled', jobsEnabled: true }, available: false },
    { name: 'agent mode malformed despite jobs switch', config: { mode: 'other', jobsEnabled: true }, available: false },
    { name: 'test identity allowlisted', config: { mode: 'test', jobsEnabled: true, testUids: [USER.uid] }, available: true, jobs: true },
    { name: 'test identity unlisted', config: { mode: 'test', jobsEnabled: true, testUids: ['other'] }, available: false },
    { name: 'test identity allowlisted without jobs switch', config: { mode: 'test', testUids: [USER.uid] }, available: true },
  ]) {
    test(`managed ${accountType} jobs negotiation: ${scenario.name}`, async () => {
      const user = { ...USER, accountType };
      const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
      const { fake, buildManagedApp, buildManagedAgentApp, mods } = boot({ user, profile });
      seedBaseline(fake._state, {
        'systemConfig/managedAgent': { testUids: [], ...scenario.config },
        'systemConfig/individualCreditFlags': { enforcementEnabled: true },
      });
      const before = JSON.stringify(fake._state);
      const accessServer = await listen(buildManagedApp());
      try {
        const response = await fetch(`http://127.0.0.1:${accessServer.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.allowed, true);
        assert.equal(body.agentAvailable, scenario.available);
        assert.equal(body.agentJobs, scenario.jobs ? 'jobs_v1' : undefined);
        assert.deepEqual(body.toolCapabilities, ['agent_skills_v1']);
        assert.equal(body.agentCoordination, undefined);
        assert.equal(body.agentTerminal, undefined);
        assert.equal(body.agentPty, undefined);
        assert.equal(body.agentMcp, scenario.available ? 'mcp_v1' : undefined);
        assertNoLeak(JSON.stringify(body), 'jobs access response');
        assert.equal(body.jobsTestUids, undefined, 'qualification UIDs are admin-only');
      } finally { accessServer.close(); }
      assert.equal(JSON.stringify(fake._state), before, 'access preflight cannot change quota or configuration');
      if (!scenario.jobs) {
        let keyReads = 0;
        let dispatches = 0;
        mods.aiConnection.resolveActiveManagedKey = async () => { keyReads++; return Buffer.from(KEY_MATERIAL); };
        await withFetch(async () => { dispatches++; throw new Error('unexpected jobs dispatch'); }, async () => {
          const server = await listen(buildManagedAgentApp());
          try {
            const result = await postTurn(server.address().port, agentBody({
              agentMode: 'plan', toolCapabilityVersion: 'agent_jobs_v1',
              accountingPeriod: require('../src/services/managedAccountingIdentity').accountingPeriod(),
            }));
            assert.equal(result.status, 403, result.text);
            assert.equal(JSON.parse(result.text).error.code, 'MANAGED_AGENT_DISABLED');
          } finally { server.close(); }
        });
        assert.equal(keyReads, 0);
        assert.equal(dispatches, 0);
        assert.equal(JSON.stringify(fake._state), before, 'jobs denial cannot create or reserve accounting records');
      }
    });
  }
}

test('production individual jobs switch cannot bypass credit readiness', async () => {
  const user = { ...USER, accountType: 'individual' };
  const { fake, buildManagedApp, buildManagedAgentApp, mods } = boot({ user, profile: activeIndividualProfile(user) });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'enabled', jobsEnabled: true } });
  const before = JSON.stringify(fake._state);
  const accessServer = await listen(buildManagedApp());
  try {
    const response = await fetch(`http://127.0.0.1:${accessServer.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
    const body = await response.json();
    assert.equal(body.allowed, true);
    assert.equal(body.agentAvailable, false);
    assert.equal(body.agentJobs, undefined);
    assert.equal(body.agentCoordination, undefined);
  } finally { accessServer.close(); }
  let keyReads = 0;
  let dispatches = 0;
  mods.aiConnection.resolveActiveManagedKey = async () => { keyReads++; return Buffer.from(KEY_MATERIAL); };
  await withFetch(async () => { dispatches++; throw new Error('unexpected jobs dispatch'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody({
        agentMode: 'plan', toolCapabilityVersion: 'agent_jobs_v1',
        accountingPeriod: require('../src/services/managedAccountingIdentity').accountingPeriod(),
      }));
      assert.equal(result.status, 503, result.text);
      assert.equal(JSON.parse(result.text).error.code, 'CREDITS_NOT_CONFIGURED');
    } finally { server.close(); }
  });
  assert.equal(keyReads, 0);
  assert.equal(dispatches, 0);
  assert.equal(JSON.stringify(fake._state), before);
});

for (const accountType of ['school', 'individual']) {
  test(`production ${accountType} qualification jobs dispatch settles usage and rechecks removal before another turn`, async () => {
    const user = { ...USER, accountType };
    const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
    const { fake, buildManagedAgentApp, mods } = boot({ user, profile });
    seedBaseline(fake._state, {
      'systemConfig/managedAgent': { mode: 'enabled', jobsEnabled: false, jobsTestUids: [user.uid] },
      'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true },
    });
    fake._state['approvedModels/mdl_a'].pricing = { input: '0.000010', output: '0.000050' };
    if (accountType === 'individual') seedCurrentWallet(fake._state, profile);
    let keyReads = 0;
    let dispatches = 0;
    mods.aiConnection.resolveActiveManagedKey = async () => { keyReads++; return Buffer.from(KEY_MATERIAL); };
    await withFetch(async (_url, init) => {
      dispatches++;
      const sent = JSON.parse(init.body);
      assert.equal(sent.tools.filter(t => t.function.name.startsWith('job_')).length, 7);
      assert.equal(sent.tools.some(t => t.function.name === 'job_promote'), false);
      assert.equal(sent.tools.some(t => t.function.name === 'run_shell_command'), false);
      return { status: 200, body: providerSse([textChunk('qualified plan', 'stop'), frame({ usage: { prompt_tokens: 1000, completion_tokens: 200 } })]) };
    }, async () => {
      const server = await listen(buildManagedAgentApp());
      try {
        const body = agentBody({ agentMode: 'plan', toolCapabilityVersion: 'agent_jobs_v1', accountingPeriod: require('../src/services/managedAccountingIdentity').accountingPeriod() });
        const accepted = await postTurn(server.address().port, body);
        assert.equal(accepted.status, 200, accepted.text);
        assert.ok(parseSse(accepted.text).some(event => event.event === 'done'));
        assertNoLeak(accepted.text, 'qualification plan');
        fake._state['systemConfig/managedAgent'].jobsTestUids = [];
        const beforeRemovalTurn = JSON.stringify(fake._state);
        const denied = await postTurn(server.address().port, { ...body, providerRequestIndex: 1 });
        assert.equal(denied.status, 403, denied.text);
        assert.equal(JSON.parse(denied.text).error.code, 'MANAGED_AGENT_DISABLED');
        assert.equal(JSON.stringify(fake._state), beforeRemovalTurn, 'removed qualification cannot reserve or debit another turn');
      } finally { server.close(); }
    });
    assert.equal(dispatches, 1);
    assert.equal(keyReads, 1);
    if (accountType === 'individual') {
      const wallet = fake._state[`creditAccounts/${user.uid}`];
      assert.equal(wallet.reservedCreditsMilli, 0);
      assert.equal(wallet.rolloverRemainingCreditsMilli, 180_000);
      assert.ok(!Object.keys(fake._state).some(key => key.startsWith('usageMonthly/')));
    } else {
      const usage = fake._state[`usageMonthly/${mods.quota.currentMonthIST()}/users/${user.uid}`];
      assert.equal(usage.inputTokens, 1000);
      assert.equal(usage.outputTokens, 200);
      assert.equal(usage.requests, 1);
      assert.deepEqual(usage.activeReservations, {});
      assert.ok(!Object.keys(fake._state).some(key => key.startsWith('creditAccounts/')));
    }
  });
}

// Production individual turns must never enter observation accounting when
// enforcement configuration is absent, unreadable or not explicitly enabled.
const CREDIT_GUARD_CASES = [
  { name: 'missing flags document' },
  { name: 'unavailable flags store', failCreditFlagsRead: true },
  { name: 'enforcement disabled', flags: { enforcementEnabled: false, fullAgentCapabilitiesEnabled: true } },
  { name: 'missing enforcement flag', flags: { fullAgentCapabilitiesEnabled: true } },
  { name: 'malformed enforcement flag', flags: { enforcementEnabled: 'true', fullAgentCapabilitiesEnabled: true } },
];

for (const accountType of ['school', 'individual']) {
  for (const terminalEnabled of [false, undefined]) {
    test(`production ${accountType} full capabilities respect terminal switch ${terminalEnabled}`, async () => {
      const user = { ...USER, uid: `terminal-guard-${accountType}`, accountType };
      const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
      const { fake, buildManagedApp, buildManagedAgentApp, mods } = boot({ user, profile });
      seedBaseline(fake._state, {
        'systemConfig/managedAgent': { mode: 'enabled', testUids: [], ...(terminalEnabled === undefined ? {} : { terminalEnabled }) },
        'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true },
      });
      if (accountType === 'individual') seedCurrentWallet(fake._state, profile);
      fake._state['approvedModels/mdl_a'].capabilities.agentVerify = 'verified';
      fake._state['approvedModels/mdl_a'].capabilities.agentTerminal = 'verified';
      let keyReads = 0;
      mods.aiConnection.resolveActiveManagedKey = async () => { keyReads++; return Buffer.from(KEY_MATERIAL); };
      const accessServer = await listen(buildManagedApp());
      try {
        const response = await fetch(`http://127.0.0.1:${accessServer.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
        const body = await response.json();
        assert.equal(body.allowed, true);
        assert.equal(body.agentAvailable, true);
        assert.equal(body.agentFile, 'build');
        assert.equal(body.agentTerminal, undefined);
      } finally { accessServer.close(); }
      let dispatches = 0;
      await withFetch(async () => { dispatches++; throw new Error('unexpected terminal dispatch'); }, async () => {
        const server = await listen(buildManagedAgentApp());
        try {
          for (const toolCapabilityVersion of ['terminal_v1', 'agent_v2', 'agent_v3']) {
            const result = await postTurn(server.address().port, agentBody({ agentMode: 'build', toolCapabilityVersion }));
            assert.equal(result.status, 403, result.text);
            assert.equal(JSON.parse(result.text).error.code, 'AGENT_BUILD_LOCKED');
          }
        } finally { server.close(); }
      });
      assert.equal(dispatches, 0);
      assert.equal(keyReads, 0);
      assert.equal(Object.keys(fake._state).some(key => key.startsWith('agentTurns/')), false);
    });
  }
}

function activeIndividualProfile(user) {
  const periodStartMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  const periodEndMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1);
  return { ...user, subscription: { subiCodeActive: true, periodStartMs, periodEndMs, paidThroughMs: periodEndMs, renewalDateMs: periodEndMs } };
}

function seedCurrentWallet(state, profile) {
  const { periodStartMs, periodEndMs } = profile.subscription;
  state[`creditAccounts/${profile.uid}`] = {
    uid: profile.uid, cycleId: `${profile.uid}:${periodStartMs}:${periodEndMs}`,
    cycleStartedAtMs: periodStartMs, cycleEndsAtMs: periodEndMs, subscriptionActive: true,
    monthlyGrantCreditsMilli: 1_000_000, monthlyRemainingCreditsMilli: 1_000_000,
    rolloverRemainingCreditsMilli: 200_000, rolloverExpiresAtMs: periodEndMs,
    topupRemainingCreditsMilli: 500_000, reservedCreditsMilli: 0, activeReservations: {},
  };
}

for (const accountType of ['school', 'individual']) for (const denied of ['model', 'quota']) {
  test(`selected role context cannot bypass ${accountType} ${denied} authority`, async () => {
    const user = { ...USER, uid: `selected-${accountType}`, accountType };
    const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
    const { fake, buildManagedAgentApp } = boot({ user, profile });
    seedBaseline(fake._state, {
      'systemConfig/managedAgent': { mode: 'enabled' },
      'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true },
    });
    fake._state['approvedModels/mdl_a'].pricing = { input: '0.000010', output: '0.000050' };
    if (accountType === 'individual') seedCurrentWallet(fake._state, profile);
    if (denied === 'model') fake._state['approvedModels/mdl_a'].enabled = false;
    else if (accountType === 'school') fake._state['schoolLimits/s1'].monthlyTokens.student = 0;
    else Object.assign(fake._state[`creditAccounts/${user.uid}`], { monthlyRemainingCreditsMilli: 0, rolloverRemainingCreditsMilli: 0, topupRemainingCreditsMilli: 0 });
    let dispatches = 0;
    await withFetch(async () => { dispatches++; throw Error('must not dispatch'); }, async () => {
      const server = await listen(buildManagedAgentApp());
      try {
        const result = await postTurn(server.address().port, agentBody({ toolCapabilityVersion: 'agent_skills_v1', agentSkillsContext: { agent: { catalogId: 'agent:review', baseProfile: 'review', instructions: 'Check correctness.', contentHash: 'a'.repeat(64) } } }));
        assert.equal(result.status, denied === 'quota' && accountType === 'individual' ? 402 : 403, result.text);
        assert.equal(JSON.parse(result.text).error.code, denied === 'model' ? 'MODEL_NOT_ALLOWED' : accountType === 'school' ? 'MONTHLY_LIMIT_EXCEEDED' : 'INSUFFICIENT_CREDITS');
      } finally { server.close(); }
    });
    assert.equal(dispatches, 0);
    if (accountType === 'individual') assert.ok(!Object.keys(fake._state).some(key => key.startsWith('usageMonthly/')));
    else assert.ok(!Object.keys(fake._state).some(key => key.startsWith('creditAccounts/')));
  });
}

for (const scenario of CREDIT_GUARD_CASES) {
  for (const agentMode of ['ask', 'build']) {
    test(`production individual ${agentMode} fails closed before accounting or dispatch: ${scenario.name}`, async () => {
      const user = { ...USER, uid: 'new-individual', accountType: 'individual' };
      const profile = activeIndividualProfile(user);
      const store = makeFakeSubiDb(scenario);
      const { fake, buildManagedAgentApp, mods } = boot({ user, profile, store });
      seedBaseline(fake._state, {
        ...(scenario.flags ? { 'systemConfig/individualCreditFlags': scenario.flags } : {}),
        'approvedModels/mdl_a': {
          modelKey: 'mdl_a', upstreamModelId: UPSTREAM, enabled: true,
          capabilities: { toolCalling: true, agentTerminal: 'verified', agentVerify: 'verified' },
          contextLength: 8192, pricing: { input: '0.000010', output: '0.000050' },
        },
      });
      seedCurrentWallet(fake._state, profile);
      const before = JSON.stringify(fake._state);
      let cycleCalls = 0;
      const ready = require('../src/services/individualCreditReadyService');
      const ensureReady = ready.ensureIndividualCreditReady;
      ready.ensureIndividualCreditReady = async (...args) => { cycleCalls++; return ensureReady(...args); };
      let keyCalls = 0;
      mods.aiConnection.resolveActiveManagedKey = async () => { keyCalls++; return Buffer.from(KEY_MATERIAL); };
      let dispatches = 0;
      await withFetch(async () => {
        dispatches++;
        return { status: 200, body: providerSse([textChunk('ok', 'stop'), frame({ usage: { prompt_tokens: 1000, completion_tokens: 200 } })]) };
      }, async () => {
        const server = await listen(buildManagedAgentApp());
        try {
          const result = await postTurn(server.address().port, agentBody({
            agentMode, toolCapabilityVersion: agentMode === 'build' ? 'agent_v3' : 'read_v1',
          }));
          assert.equal(result.status, 503, result.text);
          assert.equal(JSON.parse(result.text).error.code, 'CREDITS_NOT_CONFIGURED');
          assertNoLeak(result.text, 'production enforcement guard');
        } finally { server.close(); }
      });
      assert.equal(cycleCalls, 0, 'denied turns cannot ensure or advance a credit cycle');
      assert.equal(keyCalls, 0);
      assert.equal(dispatches, 0);
      assert.equal(JSON.stringify(fake._state), before, 'denied turns cannot reserve, debit or create accounting records');
      assert.ok(!fake._reads.some(key => key.startsWith('creditAccounts/') || key.startsWith('individualTurnRequests/') || key.startsWith('usageMonthly/')));
    });
  }

  test(`production individual readiness withholds agent capabilities while preserving admission: ${scenario.name}`, async () => {
    const user = { ...USER, uid: 'new-individual', accountType: 'individual' };
    const store = makeFakeSubiDb(scenario);
    const { fake, buildManagedApp } = boot({ user, profile: activeIndividualProfile(user), store });
    seedBaseline(fake._state, scenario.flags ? { 'systemConfig/individualCreditFlags': scenario.flags } : {});
    const before = JSON.stringify(fake._state);
    const server = await listen(buildManagedApp());
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.allowed, true);
      assert.equal(body.agentAvailable, false);
      assert.equal(body.agentFile, undefined);
      assert.equal(body.agentTerminal, undefined);
      assert.equal(body.accountType, 'individual');
      assert.equal(body.quotaMode, 'individual_credits');
    } finally { server.close(); }
    assert.equal(JSON.stringify(fake._state), before);
  });
}

test('staged individual readiness preserves allowlisted Build with credit enforcement disabled', async () => {
  const user = { ...USER, accountType: 'individual' };
  const { fake, buildManagedApp } = boot({ user, profile: activeIndividualProfile(user) });
  seedBaseline(fake._state, {
    'systemConfig/managedAgent': { mode: 'test', testUids: [user.uid], terminalEnabled: true },
    'systemConfig/individualCreditFlags': { enforcementEnabled: false },
  });
  const server = await listen(buildManagedApp());
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
    const body = await response.json();
    assert.equal(body.allowed, true);
    assert.equal(body.agentAvailable, true);
    assert.equal(body.agentFile, 'build');
    assert.equal(body.agentTerminal, 'terminal');
  } finally { server.close(); }
});

for (const toolCapabilityVersion of ['agent_v3', 'agent_skills_v1', 'agent_jobs_v1', 'agent_mcp_skills_v1', 'agent_mcp_v1', 'agent_pty_skills_v1', 'agent_pty_v1', 'agent_jobs_coordination_v1', 'agent_mcp_coordination_v1', 'agent_pty_coordination_v1']) for (const accountType of ['school', 'individual']) {
  test(`production ${accountType} ${toolCapabilityVersion} unlisted identity receives Build and settles its own accounting`, async () => {
    const user = { ...USER, uid: `new-${accountType}`, accountType };
    const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
    const { fake, buildManagedApp, buildManagedAgentApp, mods } = boot({ user, profile });
    seedBaseline(fake._state, {
      'systemConfig/managedAgent': { mode: 'enabled', testUids: ['old-tester'], terminalEnabled: true, jobsEnabled: ['agent_jobs_v1','agent_mcp_v1','agent_pty_v1'].includes(toolCapabilityVersion) || toolCapabilityVersion.includes('_coordination_'), ...(toolCapabilityVersion.includes('_coordination_') ? { coordinationEnabled: true } : {}) },
      'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true },
    });
    fake._state['approvedModels/mdl_a'].pricing = { input: '0.000010', output: '0.000050' };
    fake._state['approvedModels/mdl_a'].capabilities.agentTerminal = 'verified';
    fake._state['approvedModels/mdl_a'].capabilities.agentVerify = 'verified';
    if (accountType === 'individual') {
      seedCurrentWallet(fake._state, profile);
      // Individuals use their approved-model universe and credits even when
      // legacy school/token policies would deny them.
      fake._state['schoolModelPolicies/s1'].roles.student.modelKeys = [];
      fake._state['schoolLimits/s1'].monthlyTokens.student = 0;
    }
    mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
    const accessServer = await listen(buildManagedApp());
    try {
      const response = await fetch(`http://127.0.0.1:${accessServer.address().port}/managed/access-status`, { headers: { Authorization: 'Bearer test-token' } });
      const body = await response.json();
      assert.equal(body.allowed, true);
      assert.equal(body.agentAvailable, true);
      assert.equal(body.agentFile, 'build');
      assert.equal(body.agentTerminal, 'terminal');
      assert.equal(body.testUids, undefined);
      assert.deepEqual(body.toolCapabilities, ['agent_skills_v1']);
      assert.equal(body.agentJobs, ['agent_jobs_v1','agent_mcp_v1','agent_pty_v1'].includes(toolCapabilityVersion) || toolCapabilityVersion.includes('_coordination_') ? 'jobs_v1' : undefined);
      assert.equal(body.agentMcp, 'mcp_v1');
      assert.equal(body.agentPty, 'pty_v1');
      assert.equal(body.agentCoordination, toolCapabilityVersion.includes('_coordination_') ? 'coordination_v1' : undefined);
    } finally { accessServer.close(); }
    let dispatches = 0;
    await withFetch(async (url, init) => {
      dispatches++;
      const sent = JSON.parse(init.body);
      assert.equal(sent.tools.filter(t=>t.function.name === 'start_terminal_session').length, toolCapabilityVersion.startsWith('agent_pty') ? 1 : 0);
      assert.equal(sent.tools.filter(t => t.function.name.startsWith('mcp_')).length, (toolCapabilityVersion.startsWith('agent_mcp') || toolCapabilityVersion.startsWith('agent_pty')) ? 6 : 0);
      assert.equal(sent.tools.some(t => t.function.name === 'load_skill_resource'), ['agent_skills_v1', 'agent_jobs_v1', 'agent_mcp_skills_v1', 'agent_mcp_v1', 'agent_pty_skills_v1', 'agent_pty_v1'].includes(toolCapabilityVersion) || toolCapabilityVersion.includes('_coordination_'));
      if (['agent_skills_v1', 'agent_jobs_v1', 'agent_mcp_skills_v1', 'agent_mcp_v1', 'agent_pty_skills_v1', 'agent_pty_v1'].includes(toolCapabilityVersion) || toolCapabilityVersion.includes('_coordination_')) assert.ok(sent.messages[0].content.includes('Inspect safely.'));
      if (toolCapabilityVersion === 'agent_jobs_v1') assert.equal(sent.tools.filter(t => t.function.name.startsWith('job_')).length, 8);
      return { status: 200, body: providerSse([textChunk('ok', 'stop'), frame({ usage: { prompt_tokens: 1000, completion_tokens: 200 } })]) };
    }, async () => {
      const server = await listen(buildManagedAgentApp());
      try {
        const result = await postTurn(server.address().port, agentBody({ agentMode: 'build', toolCapabilityVersion, ...(['agent_jobs_v1','agent_mcp_v1','agent_pty_v1'].includes(toolCapabilityVersion) || toolCapabilityVersion.includes('_coordination_') ? { accountingPeriod: mods.managedAccountingIdentity?.accountingPeriod?.() || require('../src/services/managedAccountingIdentity').accountingPeriod() } : {}), ...(['agent_skills_v1', 'agent_jobs_v1', 'agent_mcp_skills_v1', 'agent_mcp_v1', 'agent_pty_skills_v1', 'agent_pty_v1'].includes(toolCapabilityVersion) || toolCapabilityVersion.includes('_coordination_') ? { agentSkillsContext: { agent: { catalogId: 'agent:review', baseProfile: 'review', contentHash: 'a'.repeat(64), instructions: 'Inspect safely.' } } } : {}) }));
        assert.equal(result.status, 200, result.text);
        const events = parseSse(result.text);
        assert.ok(events.some(event => event.event === 'done'), result.text);
        assert.ok(!events.some(event => event.event === 'error'), result.text);
        assertNoLeak(result.text, 'production Build');
      } finally { server.close(); }
    });
    assert.equal(dispatches, 1);
    if (accountType === 'individual') {
      const wallet = fake._state[`creditAccounts/${user.uid}`];
      // $10/$50 per million at 1000 input + 200 output = 20,000 milli.
      assert.equal(wallet.rolloverRemainingCreditsMilli, 180_000);
      assert.equal(wallet.monthlyRemainingCreditsMilli, 1_000_000);
      assert.equal(wallet.topupRemainingCreditsMilli, 500_000);
      assert.equal(wallet.reservedCreditsMilli, 0);
      assert.deepEqual(wallet.activeReservations, {});
      const reservation = Object.values(fake._state).filter(doc => doc.type === 'reservation');
      assert.equal(reservation.length, 1);
      assert.equal(reservation[0].state, 'committed');
      assert.equal(reservation[0].actualMilli, 20_000);
      assert.ok(!Object.keys(fake._state).some(key => key.startsWith('usageMonthly/') || key.startsWith('usageRequests/')));
    } else {
      const usage = Object.entries(fake._state).find(([key]) => key.startsWith('usageMonthly/') && key.endsWith(`/users/${user.uid}`));
      assert.ok(usage);
      assert.equal(usage[1].inputTokens, 1000);
      assert.equal(usage[1].outputTokens, 200);
      assert.equal(usage[1].requests, 1);
      assert.ok(!Object.keys(fake._state).some(key => key.startsWith('creditAccounts/') || key.startsWith('individualTurnRequests/')));
    }
  });
}

for (const agentMode of ['ask', 'plan']) {
  for (const scenario of [
    { name: 'expired school subscription', school: { accountType: 'school', subscription: { renewalDateMs: Date.now() - 1000 } }, code: 'SUBI_PLAN_EXPIRED', status: 403 },
    { name: 'expired user subscription', profile: { ...USER, subscription: { renewalDateMs: Date.now() - 1000 } }, code: 'SUBI_PLAN_EXPIRED', status: 403 },
    { name: 'unavailable school directory', schoolReadError: true, code: 'SUBI_ACCESS_UNAVAILABLE', status: 503 },
    { name: 'profile deleted after authentication', profile: null, code: 'SUBI_ACCESS_UNAVAILABLE', status: 503 },
    { name: 'linked school deleted after authentication', school: null, code: 'SUBI_ACCESS_UNAVAILABLE', status: 503 },
    { name: 'school link removed after authentication', profile: { ...USER, schoolId: '' }, code: 'SUBI_ACCESS_UNAVAILABLE', status: 503 },
    { name: 'linked school has individual account type', school: { accountType: 'individual' }, code: 'FORBIDDEN', status: 403 },
    { name: 'linked school account type is missing', school: {}, code: 'FORBIDDEN', status: 403 },
  ]) {
    test(`production school ${agentMode} rechecks entitlement before quota or dispatch: ${scenario.name}`, async () => {
      const { fake, buildManagedAgentApp, mods } = boot({ user: USER, profile: USER, ...scenario });
      seedBaseline(fake._state);
      const before = JSON.stringify(fake._state);
      let keyCalls = 0;
      mods.aiConnection.resolveActiveManagedKey = async () => { keyCalls++; return Buffer.from(KEY_MATERIAL); };
      let dispatches = 0;
      await withFetch(async () => {
        dispatches++;
        return { status: 200, body: providerSse([textChunk('ok', 'stop'), frame({ usage: { prompt_tokens: 1000, completion_tokens: 200 } })]) };
      }, async () => {
        const server = await listen(buildManagedAgentApp());
        try {
          const result = await postTurn(server.address().port, agentBody({ agentMode }));
          assert.equal(result.status, scenario.status, result.text);
          assert.equal(JSON.parse(result.text).error.code, scenario.code);
          assertNoLeak(result.text, 'school entitlement guard');
        } finally { server.close(); }
      });
      assert.equal(keyCalls, 0);
      assert.equal(dispatches, 0);
      assert.equal(JSON.stringify(fake._state), before, 'school entitlement denials cannot mutate quotas or wallets');
      assert.ok(!fake._reads.some(key => key.startsWith('usageMonthly/') || key.startsWith('usageRequests/') || key.startsWith('creditAccounts/')));
    });
  }
}

for (const agentMode of ['ask', 'plan']) {
  test(`production school ${agentMode} preserves token accounting for typed records with unspecified expiry`, async () => {
    const { fake, buildManagedAgentApp, mods } = boot({ user: USER, profile: USER, school: { id: USER.schoolId, accountType: 'school' } });
    seedBaseline(fake._state);
    mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
    let dispatches = 0;
    await withFetch(async () => {
      dispatches++;
      return { status: 200, body: providerSse([textChunk('ok', 'stop'), frame({ usage: { prompt_tokens: 1000, completion_tokens: 200 } })]) };
    }, async () => {
      const server = await listen(buildManagedAgentApp());
      try {
        const result = await postTurn(server.address().port, agentBody({ agentMode }));
        assert.equal(result.status, 200, result.text);
        assert.ok(parseSse(result.text).some(event => event.event === 'done'), result.text);
        assert.ok(!parseSse(result.text).some(event => event.event === 'error'), result.text);
      } finally { server.close(); }
    });
    assert.equal(dispatches, 1);
    const usage = Object.entries(fake._state).find(([key]) => key.startsWith('usageMonthly/') && key.endsWith(`/users/${USER.uid}`));
    assert.ok(usage);
    assert.equal(usage[1].inputTokens, 1000);
    assert.equal(usage[1].outputTokens, 200);
    assert.equal(usage[1].requests, 1);
    assert.ok(!Object.keys(fake._state).some(key => key.startsWith('creditAccounts/') || key.startsWith('individualTurnRequests/')));
  });
}

test("route idempotent replay does not double-charge", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return {
      status: 200,
      body: providerSse([textChunk("Hello", null), frame({ choices: [{ finish_reason: "stop" }] })]),
    };
  };
  await withFetch(provider, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const port = s.address().port;
      const first = await postTurn(port, agentBody());
      assert.equal(first.status, 200);
      assert.ok(parseSse(first.text).some((e) => e.event === "done"));
      const second = await postTurn(port, agentBody());
      assert.equal(second.status, 409);
      const parsed = JSON.parse(second.text);
      assert.ok(["REQUEST_ALREADY_PROCESSED", "REQUEST_IN_PROGRESS"].includes(parsed.error.code));
    } finally {
      s.close();
    }
  });
  assert.equal(providerCalls, 1);
  const period = mods.quota.currentMonthIST();
  const userDoc = fake._state[`usageMonthly/${period}/users/u1`];
  assert.deepEqual(userDoc.activeReservations, {});
  assert.equal(userDoc.requests, 1);
});

test("route gate-disabled and access-disabled deny pre-stream without provider calls", async () => {
  for (const [seed, code, status] of [
    [{ "systemConfig/managedAgent": { mode: "disabled", testUids: [] } }, "MANAGED_AGENT_DISABLED", 403],
    [{ "systemConfig/subiAccess": { enabled: false } }, "SUBI_ACCESS_DISABLED", 403],
  ]) {
    const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
    seedBaseline(fake._state, seed);
    mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
    let providerCalls = 0;
    await withFetch(async () => {
      providerCalls += 1;
      return { status: 200, body: providerSse([textChunk("x", "stop")]) };
    }, async () => {
      const s = await listen(buildManagedAgentApp());
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/agent/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
          body: JSON.stringify(agentBody()),
        });
        assert.equal(res.status, status);
        const parsed = await res.json();
        assert.equal(parsed.error.code, code);
      } finally {
        s.close();
      }
    });
    assert.equal(providerCalls, 0);
  }
});

test("route 503 surfaces httpStatus in the error frame for retry classification", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async () => ({ status: 503, body: null }), async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const { status, text } = await postTurn(s.address().port, agentBody());
      assert.equal(status, 200);
      const events = parseSse(text);
      const err = events.find((e) => e.event === "error");
      assert.ok(err, "SSE error frame present");
      assert.equal(err.data.code, "PROVIDER_UNAVAILABLE");
      assert.equal(err.data.httpStatus, 503);
      assertNoLeak(text, "503 classification");
    } finally {
      s.close();
    }
  });
});

test("test-UID build request receives exact terminal_v1 provider schemas", async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [USER.uid], terminalEnabled: true },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerBody;
  await withFetch(async (_url, init) => {
    providerBody = JSON.parse(init.body);
    return {
      status: 200,
      body: providerSse([
        textChunk("Ready", null),
        frame({ choices: [{ finish_reason: "stop" }] }),
        frame({ usage: { prompt_tokens: 20, completion_tokens: 3 } }),
      ]),
    };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({
        agentMode: "build",
        toolCapabilityVersion: "terminal_v1",
      }));
      assert.equal(result.status, 200);
      assert.ok(parseSse(result.text).some((event) => event.event === "done"));
    } finally {
      s.close();
    }
  });
  assert.deepEqual(providerBody.tools.map((d) => d.function.name), [
    "run_command", "terminal_status", "cancel_command",
    "get_workspace_info",
    "find_files",
    "search_text",
    "read_file",
    "propose_patch",
    "apply_patch",
    "undo_change",
  ]);
  const propose = providerBody.tools.find((d) => d.function.name === "propose_patch");
  assert.ok(propose.function.parameters.properties.oldString);
  assert.ok(propose.function.parameters.properties.newString);
  assert.deepEqual(propose.function.parameters.required, []);
});

for (const scenario of [
  { name: 'missing terminal switch', config: { mode: 'test', testUids: [USER.uid] } },
  { name: 'global enabled mode', config: { mode: 'enabled', testUids: [USER.uid], terminalEnabled: true } },
  { name: 'unlisted identity', config: { mode: 'test', testUids: ['other'], terminalEnabled: true } },
  { name: 'individual without subscription', config: { mode: 'test', testUids: [USER.uid], terminalEnabled: true }, accountType: 'individual' },
]) test('terminal route refuses ' + scenario.name + ' before provider dispatch', async () => {  const { fake, buildManagedAgentApp } = boot({ user: { ...USER, accountType: scenario.accountType || 'school' } });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': scenario.config });
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody({ agentMode: 'build', toolCapabilityVersion: 'terminal_v1' }));
      assert.equal(result.status, 403);
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
});

test('terminal route refuses explicitly terminal-incompatible model with zero dispatch', async () => {
  const { fake, buildManagedAgentApp } = boot({ user: USER });
  seedBaseline(fake._state, {
    'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid], terminalEnabled: true },
    'approvedModels/mdl_a': {
      modelKey: 'mdl_a',
      displayName: 'Model A',
      upstreamModelId: UPSTREAM,
      enabled: true,
      roles: { student: { enabled: true }, teacher: { enabled: true } },
      capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: true, agentTerminal: 'unsupported' },
      contextLength: 8192,
    },
  });
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody({ agentMode: 'build', toolCapabilityVersion: 'terminal_v1' }));
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.text).error.code, 'MODEL_TERMINAL_UNSUPPORTED');
      assertNoLeak(result.text, 'terminal-incompatible refusal');
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
});

test('terminal done event carries allowlisted finish reason', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, {
    'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid], terminalEnabled: true },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async () => ({
    status: 200,
    body: providerSse([
      textChunk('v', null),
      frame({ choices: [{ finish_reason: 'stop' }] }),
      frame({ usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    ]),
  }), async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({ agentMode: 'build', toolCapabilityVersion: 'terminal_v1' }));
      assert.equal(result.status, 200);
      const done = parseSse(result.text).find((e) => e.event === 'done');
      assert.ok(done, 'done frame present');
      assert.equal(done.data.finishReason, 'stop');
    } finally { s.close(); }
  });
});

// ---------- Phase 17I: verify_v1 provider bundle, preflight, fixture ----------

function seedVerifyModel(st, agentVerify) {
  st['approvedModels/mdl_a'] = {
    modelKey: 'mdl_a',
    displayName: 'Model A',
    upstreamModelId: UPSTREAM,
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: {
      inputModalities: ['text'], outputModalities: ['text'], toolCalling: true,
      ...(agentVerify !== undefined ? { agentVerify } : {}),
    },
    contextLength: 8192,
  };
}

function verifyBody(over = {}) {
  return agentBody({ agentMode: 'build', toolCapabilityVersion: 'verify_v1', ...over });
}

test('test-UID verify request receives exact 18-tool provider bundle', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid] } });
  seedVerifyModel(fake._state, 'verified');
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerBody;
  await withFetch(async (_url, init) => {
    providerBody = JSON.parse(init.body);
    return {
      status: 200,
      body: providerSse([
        textChunk('Ready', null),
        frame({ choices: [{ finish_reason: 'stop' }] }),
        frame({ usage: { prompt_tokens: 20, completion_tokens: 3 } }),
      ]),
    };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, verifyBody());
      assert.equal(result.status, 200);
      assert.ok(parseSse(result.text).some((event) => event.event === 'done'));
    } finally { s.close(); }
  });
  assert.deepEqual(providerBody.tools.map((d) => d.function.name), [
    'get_workspace_info', 'list_directory', 'find_files', 'glob', 'search_text', 'grep', 'read_file', 'get_diagnostics',
    'propose_patch', 'apply_patch', 'undo_change',
    'run_command', 'terminal_status', 'cancel_command',
    'run_typecheck', 'run_lint', 'run_build', 'run_tests',
  ]);
  assertNoLeak(JSON.stringify(providerBody.tools), 'verify bundle');
});

test('verify route refuses explicitly verify-incompatible model with zero dispatch', async () => {
  const { fake, buildManagedAgentApp } = boot({ user: USER });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid] } });
  seedVerifyModel(fake._state, 'unsupported');
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, verifyBody());
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.text).error.code, 'MODEL_VERIFY_UNSUPPORTED');
      assertNoLeak(result.text, 'verify-incompatible refusal');
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
});

test('verify route allows unknown model probe for test-listed UID only', async () => {
  // Test mode + listed UID: probe allowed (200). Enabled ("production")
  // mode: fail closed before model policy via the file entitlement gate —
  // BUILD itself is test-UID-only, so unknown models never reach dispatch.
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid] } });
  seedVerifyModel(fake._state, undefined);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async () => ({
    status: 200,
    body: providerSse([textChunk('ok', null), frame({ choices: [{ finish_reason: 'stop' }] })]),
  }), async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, verifyBody());
      assert.equal(result.status, 200);
    } finally { server.close(); }
  });
  const prod = boot({ user: USER });
  seedBaseline(prod.fake._state, { 'systemConfig/managedAgent': { mode: 'enabled', testUids: [] } });
  seedVerifyModel(prod.fake._state, undefined);
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
    const server = await listen(prod.buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, verifyBody());
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.text).error.code, 'AGENT_BUILD_LOCKED');
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
});

// ---------- Phase 18 certification: agent_v2 negotiation + preflights ----------

function agentV2Body(over = {}) {
  return agentBody({ agentMode: 'build', toolCapabilityVersion: 'agent_v2', ...over });
}

function seedAgentV2Entitled(st) {
  seedBaseline(st, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid], terminalEnabled: true } });
}

test('agent_v2 BUILD unmarked TEST model receives exact 39-tool bundle (live-failure regression)', async () => {
  // The reported live failure: an unmarked model (no agentVerify field —
  // the baseline seed has none) negotiated verify_v1 client-side. The
  // backend always served agent_v2; this pins the served bundle.
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedAgentV2Entitled(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let providerBody;
  await withFetch(async (_url, init) => {
    providerBody = JSON.parse(init.body);
    return {
      status: 200,
      body: providerSse([
        textChunk('Ready', null),
        frame({ choices: [{ finish_reason: 'stop' }] }),
        frame({ usage: { prompt_tokens: 20, completion_tokens: 3 } }),
      ]),
    };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentV2Body());
      assert.equal(result.status, 200);
      assert.ok(parseSse(result.text).some((event) => event.event === 'done'));
    } finally { s.close(); }
  });
  const names = providerBody.tools.map((d) => d.function.name);
  assert.equal(names.length, 39);
  for (const required of [
    'run_shell_command', 'git_status', 'git_diff', 'git_log', 'git_stage', 'git_unstage', 'git_commit',
    'web_fetch', 'web_search', 'external_read', 'external_write', 'external_shell', 'lsp',
    'todo_read', 'todo_write', 'delegate_task', 'ask_user', 'load_skill', 'list_skills', 'batch_tools',
    'run_command', 'terminal_status', 'cancel_command', 'run_typecheck', 'run_lint', 'run_build', 'run_tests',
    'apply_patch', 'undo_change', 'create_directory',
  ]) {
    assert.ok(names.includes(required), `agent_v2 BUILD must serve ${required}`);
  }
  assertNoLeak(JSON.stringify(providerBody.tools), 'agent_v2 bundle');
});

test('agent_v2 BUILD refuses verify-incompatible model with zero dispatch', async () => {
  const { fake, buildManagedAgentApp } = boot({ user: USER });
  seedAgentV2Entitled(fake._state);
  seedVerifyModel(fake._state, 'unsupported');
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentV2Body());
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.text).error.code, 'MODEL_VERIFY_UNSUPPORTED');
      assertNoLeak(result.text, 'agent_v2 verify-incompatible refusal');
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
});

test('agent_v2 BUILD refuses terminal-incompatible model with zero dispatch', async () => {
  const { fake, buildManagedAgentApp } = boot({ user: USER });
  seedAgentV2Entitled(fake._state);
  fake._state['approvedModels/mdl_a'] = {
    modelKey: 'mdl_a',
    displayName: 'Model A',
    upstreamModelId: UPSTREAM,
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: true, agentTerminal: 'unsupported' },
    contextLength: 8192,
  };
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentV2Body());
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.text).error.code, 'MODEL_TERMINAL_UNSUPPORTED');
      assertNoLeak(result.text, 'agent_v2 terminal-incompatible refusal');
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
});

test('agent_v2 ASK skips build-scoped model preflights for unmarked model', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedAgentV2Entitled(fake._state);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  await withFetch(async () => ({
    status: 200,
    body: providerSse([textChunk('ok', null), frame({ choices: [{ finish_reason: 'stop' }] })]),
  }), async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentV2Body({ agentMode: 'ask' }));
      assert.equal(result.status, 200);
    } finally { s.close(); }
  });
});

test('agent_v2 BUILD without terminal entitlement stays locked before dispatch', async () => {
  const { fake, buildManagedAgentApp } = boot({ user: USER });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid] } });
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentV2Body());
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.text).error.code, 'AGENT_BUILD_LOCKED');
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
});

test('verify fixture: typecheck call, failed tool result, tests call, passed text', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid] } });
  seedVerifyModel(fake._state, 'verified');
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  const toolCallChunk = (id, name, args) => frame({
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }],
  });
  const finishCalls = frame({ choices: [{ finish_reason: 'tool_calls' }] });
  const finishStop = frame({ choices: [{ finish_reason: 'stop' }] });
  const scripts = [
    () => providerSse([toolCallChunk('call-1', 'run_typecheck', {}), finishCalls]),
    () => providerSse([toolCallChunk('call-2', 'run_tests', {}), finishCalls]),
    () => providerSse([textChunk('All green.', null), finishStop]),
  ];
  let dispatches = 0;
  const seenToolCounts = [];
  await withFetch(async (_url, init) => {
    const step = dispatches;
    dispatches++;
    seenToolCounts.push(JSON.parse(init.body).tools.length);
    return { status: 200, body: scripts[step]() };
  }, async () => {
    const s = await listen(buildManagedAgentApp());
    try {
      const failedResult = (providerCallId, toolName, content) => ({
        role: 'toolResult', providerCallId, toolName, content, isError: false,
      });
      let result = await postTurn(s.address().port, verifyBody({
        clientRunId: 'fix-1', providerRequestIndex: 0,
        canonicalTurns: [{ role: 'user', content: 'Fix the type error.' }],
      }));
      assert.equal(result.status, 200);
      assert.ok(parseSse(result.text).some((e) => e.event === 'toolCallReady'));
      result = await postTurn(s.address().port, verifyBody({
        clientRunId: 'fix-1', providerRequestIndex: 1,
        canonicalTurns: [
          { role: 'user', content: 'Fix the type error.' },
          { role: 'assistantToolCalls', text: '', toolCalls: [{ providerCallId: 'call-1', toolName: 'run_typecheck', args: {} }] },
          failedResult('call-1', 'run_typecheck', 'Typecheck failed with 1 error.'),
        ],
      }));
      assert.equal(result.status, 200);
      result = await postTurn(s.address().port, verifyBody({
        clientRunId: 'fix-1', providerRequestIndex: 2,
        canonicalTurns: [
          { role: 'user', content: 'Fix the type error.' },
          { role: 'assistantToolCalls', text: '', toolCalls: [{ providerCallId: 'call-2', toolName: 'run_tests', args: {} }] },
          failedResult('call-2', 'run_tests', 'Tests passed: 3 passed.'),
        ],
      }));
      assert.equal(result.status, 200);
      assertNoLeak(result.text, 'verify fixture');
    } finally { s.close(); }
  });
  assert.equal(dispatches, 3, 'one provider dispatch per turn, no replay');
  assert.deepEqual(seenToolCounts, [18, 18, 18], 'verify bundle stable across continuation');
});

test('jobs admission rechecks flag, period, and inherited model verification gate before reservation', async () => {
  for (const scenario of ['flag', 'period', 'verify']) {
    const { fake, buildManagedAgentApp } = boot({ user: USER });
    seedAgentV2Entitled(fake._state);
    fake._state['systemConfig/managedAgent'].jobsEnabled = scenario !== 'flag';
    seedVerifyModel(fake._state, 'unsupported');
    let dispatches = 0;
    await withFetch(async () => { dispatches++; throw new Error('unexpected provider'); }, async () => {
      const server = await listen(buildManagedAgentApp());
      try {
        const result = await postTurn(server.address().port, agentV2Body({ toolCapabilityVersion: 'agent_jobs_v1', accountingPeriod: scenario === 'period' ? '2000-01' : require('../src/services/managedAccountingIdentity').accountingPeriod() }));
        assert.equal(JSON.parse(result.text).error.code, scenario === 'flag' ? 'MANAGED_AGENT_DISABLED' : scenario === 'period' ? 'REQUEST_ALREADY_PROCESSED' : 'MODEL_VERIFY_UNSUPPORTED');
      } finally { server.close(); }
    });
    assert.equal(dispatches, 0); assert.equal(Object.keys(fake._state).some(k => k.includes('/reservations/')), false);
  }
});

for (const version of ['agent_jobs_coordination_v1', 'agent_mcp_coordination_v1', 'agent_pty_coordination_v1']) for (const accountType of ['school', 'individual']) {
  test(`${version} ${accountType} rechecks coordination, jobs, period, terminal, quota and policy gates`, async () => {
    for (const scenario of ['missing', 'false', 'malformed', 'jobs', 'period', 'terminal', 'quota', 'policy']) {
      const user = { ...USER, uid: `coordination-${accountType}`, accountType, role: 'teacher' };
      const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
      const { fake, buildManagedAgentApp } = boot({ user, profile });
      seedBaseline(fake._state, {
        'systemConfig/managedAgent': { mode: 'enabled', terminalEnabled: scenario !== 'terminal', jobsEnabled: scenario !== 'jobs',
          ...(scenario === 'missing' ? {} : { coordinationEnabled: scenario === 'false' ? false : scenario === 'malformed' ? 'true' : true }) },
        'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true },
      });
      fake._state['approvedModels/mdl_a'].pricing = { input: '0.000010', output: '0.000050' };
      fake._state['approvedModels/mdl_a'].capabilities.agentVerify = 'verified'; fake._state['approvedModels/mdl_a'].capabilities.agentTerminal = 'verified';
      if (accountType === 'individual') seedCurrentWallet(fake._state, profile);
      if (scenario === 'quota') {
        if (accountType === 'school') fake._state['schoolLimits/s1'].monthlyTokens.teacher = 0;
        else Object.assign(fake._state[`creditAccounts/${user.uid}`], { monthlyRemainingCreditsMilli: 0, rolloverRemainingCreditsMilli: 0, topupRemainingCreditsMilli: 0 });
      }
      if (scenario === 'policy') {
        if (accountType === 'school') fake._state['schoolPolicies/s1'].roles.teacher.enabled = false;
        else fake._state[`userPolicies/${user.uid}`] = { accessMode: 'disabled' };
      }
      let dispatches = 0;
      await withFetch(async () => { dispatches++; throw new Error('must not dispatch'); }, async () => {
        const server = await listen(buildManagedAgentApp());
        try {
          const response = await postTurn(server.address().port, agentBody({ agentMode: 'build', toolCapabilityVersion: version,
            accountingPeriod: scenario === 'period' ? '2000-01' : require('../src/services/managedAccountingIdentity').accountingPeriod() }));
          const code = JSON.parse(response.text).error.code;
          const expected = ['missing', 'false', 'malformed', 'jobs'].includes(scenario) ? 'MANAGED_AGENT_DISABLED'
            : scenario === 'period' ? 'REQUEST_ALREADY_PROCESSED' : scenario === 'terminal' ? 'AGENT_BUILD_LOCKED'
              : scenario === 'quota' ? accountType === 'individual' ? 'INSUFFICIENT_CREDITS' : 'MONTHLY_LIMIT_EXCEEDED' : 'SUBI_ACCESS_DISABLED';
          assert.equal(code, expected, `${scenario}: ${response.text}`);
        } finally { server.close(); }
      });
      assert.equal(dispatches, 0); assert.equal(Object.keys(fake._state).some(key => key.includes('/reservations/')), false);
    }
  });
}

test('coordination continuation rechecks school policy revoked after its first provider turn', async () => {
  const { fake, buildManagedAgentApp, mods } = boot({ user: USER });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid], jobsEnabled: true, coordinationEnabled: true } });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL); let dispatches = 0;
  await withFetch(async () => { dispatches++; return { status: 200, body: providerSse([textChunk('Inspect', 'stop'), frame({ usage: { prompt_tokens: 5, completion_tokens: 2 } })]) }; }, async () => {
    const server = await listen(buildManagedAgentApp());
    try {
      const request = agentBody({ agentMode: 'plan', toolCapabilityVersion: 'agent_jobs_coordination_v1', accountingPeriod: require('../src/services/managedAccountingIdentity').accountingPeriod() });
      assert.equal((await postTurn(server.address().port, request)).status, 200);
      fake._state['schoolPolicies/s1'].roles.student.enabled = false;
      const response = await postTurn(server.address().port, { ...request, providerRequestIndex: 1 });
      assert.equal(response.status, 403); assert.equal(JSON.parse(response.text).error.code, 'SUBI_ACCESS_DISABLED');
    } finally { server.close(); }
  });
  assert.equal(dispatches, 1);
});

for (const accountType of ['school', 'individual']) test(`coordination ${accountType} rejects expired subscription before quota or provider dispatch`, async () => {
  const user = { ...USER, uid: `expired-coordination-${accountType}`, accountType };
  const profile = accountType === 'individual' ? activeIndividualProfile(user) : user;
  if (accountType === 'individual') Object.assign(profile.subscription, { renewalDateMs: Date.now() - 10000, paidThroughMs: Date.now() - 10000, periodEndMs: Date.now() - 10000 });
  const { fake, buildManagedAgentApp } = boot({ user, profile,
    ...(accountType === 'school' ? { school: { accountType: 'school', subscription: { subiCodeActive: true, renewalDateMs: Date.now() - 10000 } } } : {}) });
  seedBaseline(fake._state, { 'systemConfig/managedAgent': { mode: 'enabled', terminalEnabled: true, jobsEnabled: true, coordinationEnabled: true },
    'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true } });
  let dispatches = 0; await withFetch(async () => { dispatches++; throw new Error('must not dispatch'); }, async () => {
    const server = await listen(buildManagedAgentApp());
    try { for (const toolCapabilityVersion of ['agent_jobs_coordination_v1', 'agent_mcp_coordination_v1', 'agent_pty_coordination_v1']) for (const agentMode of ['ask', 'plan', 'build']) {
      const response = await postTurn(server.address().port, agentBody({ agentMode, toolCapabilityVersion, accountingPeriod: require('../src/services/managedAccountingIdentity').accountingPeriod() }));
      assert.equal(response.status, 403); assert.equal(JSON.parse(response.text).error.code, agentMode === 'build' ? 'AGENT_BUILD_LOCKED' : 'SUBI_PLAN_EXPIRED');
    } } finally { server.close(); }
  });
  assert.equal(dispatches, 0); assert.equal(Object.keys(fake._state).some(key => key.startsWith('usageMonthly/') || key.startsWith('creditAccounts/')), false);
});
