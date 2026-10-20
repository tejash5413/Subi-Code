// test/agentV3Route.test.js — Phase 19C: POST /agent/turn with
// toolCapabilityVersion agent_v3. Reuses the managedAgentRoute harness
// patterns (fake OpenRouter fetch, fake Firestore, stubbed auth/key).
// Proves: v3 dispatches with project tools, unknown versions and v3
// preflight violations fail closed pre-dispatch, no leaks.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

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
            const { writeDoc } = require("./orderingTx");
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

function boot({ user, store } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(SRC_FRAG)) delete require.cache[k];
  }
  const dbPath = require.resolve("../src/db");
  const fake = store || makeFakeSubiDb();
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { admin: {}, learnsmartDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) }, subiDb: fake },
  };
  const authMod = require("../src/middleware/auth");
  authMod.requireAuth = () => (req, res, next) => {
    if (!user) return res.status(401).json({ error: "Missing auth token" });
    req.subi = { ...user };
    next();
  };
  if (user?.accountType === 'school') {
    const directory = require("../src/services/learnsmartDirectoryService");
    directory.getUserProfile = async () => ({ ...user, status: 'active', subscription: null });
    directory.getSchool = async id => id === user.schoolId ? { id, accountType: 'school', subscription: null } : null;
  }
  const app = require("../src/app");
  return {
    fake,
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
  st["schoolModelPolicies/s1"] = {
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_a"] } },
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
    toolCapabilityVersion: "agent_v3",
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

const BANNED = [UPSTREAM, KEY_MATERIAL, "testUids", "reservationId", "_key", "stack", "Error:"];
function assertNoLeak(text, what) {
  for (const banned of BANNED) {
    assert.equal(text.includes(banned), false, `${what}: response leaks ${banned}`);
  }
}

function toolTurn(toolName, args) {
  return agentBody({
    canonicalTurns: [
      { role: "user", content: "go" },
      { role: "assistantToolCalls", text: "", toolCalls: [{ providerCallId: "c1", toolName, args }] },
      { role: "toolResult", providerCallId: "c1", toolName, content: "done", isError: false },
    ],
  });
}

test("v3 ask dispatches with project tools, no leak", async () => {
  const booted = boot({ user: USER });
  seedBaseline(booted.fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [USER.uid], terminalEnabled: true },
  });
  booted.mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let sawTools = null;
  await withFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    sawTools = (body.tools || []).map((t) => t.function.name);
    return {
      status: 200,
      body: providerSse([
        textChunk("v", null),
        frame({ choices: [{ finish_reason: "stop" }] }),
        frame({ usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      ]),
    };
  }, async () => {
    const s = await listen(booted.buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, toolTurn("project_overview", {}));
      assert.equal(result.status, 200);
      assert.ok((sawTools || []).includes("project_overview"), "provider saw v3 project tool");
      assert.ok((sawTools || []).includes("read_file"), "provider still sees v2 tools");
      assertNoLeak(result.text, "v3 ask dispatch");
    } finally { s.close(); }
  });
});

test("unknown capability version rejected pre-dispatch", async () => {
  const booted = boot({ user: USER });
  seedBaseline(booted.fake._state);
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error("unexpected provider"); }, async () => {
    const s = await listen(booted.buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({ toolCapabilityVersion: "agent_v9" }));
      assert.equal(result.status, 400);
      assertNoLeak(result.text, "unknown version rejection");
    } finally { s.close(); }
  });
  assert.equal(dispatches, 0);
});

for (const version of ["agent_v3", "agent_skills_v1"]) test(`${version} build refuses terminal-incompatible model with zero dispatch`, async () => {
  const booted = boot({ user: USER });
  seedBaseline(booted.fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [USER.uid], terminalEnabled: true },
    "approvedModels/mdl_a": {
      modelKey: "mdl_a",
      displayName: "Model A",
      upstreamModelId: UPSTREAM,
      enabled: true,
      roles: { student: { enabled: true }, teacher: { enabled: true } },
      capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "unsupported" },
      contextLength: 8192,
    },
  });
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error("unexpected provider"); }, async () => {
    const s = await listen(booted.buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, agentBody({ agentMode: "build", toolCapabilityVersion: version }));
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.text).error.code, "MODEL_TERMINAL_UNSUPPORTED");
      assertNoLeak(result.text, "v3 terminal-incompatible refusal");
    } finally { s.close(); }
  });
  assert.equal(dispatches, 0);
});

test("v3 malformed project args rejected pre-dispatch", async () => {
  const booted = boot({ user: USER });
  seedBaseline(booted.fake._state);
  let dispatches = 0;
  await withFetch(async () => { dispatches++; throw new Error("unexpected provider"); }, async () => {
    const s = await listen(booted.buildManagedAgentApp());
    try {
      const result = await postTurn(s.address().port, toolTurn("project_context", { query: "x" }));
      assert.equal(result.status, 400);
    } finally { s.close(); }
  });
  assert.equal(dispatches, 0);
});

test('selected managed read child dispatches only its actual schema intersection', async () => {
  const booted = boot({ user: USER });
  seedBaseline(booted.fake._state, { 'systemConfig/managedAgent': { mode: 'test', testUids: [USER.uid], terminalEnabled: true } });
  booted.mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from(KEY_MATERIAL);
  let sent;
  await withFetch(async (_url, init) => {
    sent = JSON.parse(init.body);
    return { status: 200, body: providerSse([textChunk('Reviewed.', 'stop'), frame({ usage: { prompt_tokens: 5, completion_tokens: 1 } })]) };
  }, async () => {
    const server = await listen(booted.buildManagedAgentApp());
    try {
      const result = await postTurn(server.address().port, agentBody({ agentMode: 'plan', toolCapabilityVersion: 'agent_skills_v1', agentSkillsContext: { agent: { catalogId: 'agent:review', baseProfile: 'review', contentHash: 'a'.repeat(64), allowedTools: ['read_file', 'get_diagnostics', 'unknown_tool'] } } }));
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(sent.tools.map(t => t.function.name), ['read_file', 'get_diagnostics']);
      assert.ok(sent.messages[0].content.includes('Available tools: read_file, get_diagnostics.'));
      assert.equal(sent.messages[0].content.includes('load_skill_resource reads'), false);
    } finally { server.close(); }
  });
});
