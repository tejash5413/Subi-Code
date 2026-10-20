// test/webSearch.test.js — Phase 18 certification: backend-proxied web search.
// Service unit tests use stubbed upstream fetch (no network, no secrets).
// Route tests boot the REAL agent app with stubbed auth + fake subi DB and a
// stubbed searchWeb (no upstream). No production Firestore. No deploys.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const svc = require("../src/services/webSearchService");

const okFetch = (payload, status = 200) => async () => ({
  status,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});

test("sanitize: valid technical queries pass through", () => {
  assert.equal(svc.sanitizeQuery("firebase deploy functions CLI syntax"), "firebase deploy functions CLI syntax");
  assert.equal(svc.sanitizeQuery("  npm ERR! Missing script: build  "), "npm ERR! Missing script: build");
});

test("sanitize: secret-shaped material redacted, never forwarded", () => {
  const out = svc.sanitizeQuery("firebase deploy failed with token sk-abc123XYZ89012 please help");
  assert.equal(out.includes("sk-abc123XYZ89012"), false);
  assert.match(out, /\[redacted\]/);
  const gh = svc.sanitizeQuery("error using ghp_abcdefghijklmnopqrstu in script");
  assert.equal(gh.includes("ghp_abcdefghijklmnopqrstu"), false);
  const bearer = svc.sanitizeQuery("call failed Authorization: Bearer ya29.secret-token here");
  assert.equal(bearer.includes("ya29.secret-token"), false);
  const env = svc.sanitizeQuery("here is my .env contents API_KEY=xyz");
  assert.equal(env.includes("API_KEY=xyz"), false);
  const key = svc.sanitizeQuery("-----BEGIN PRIVATE KEY-----\nMIIBvQ\n-----END PRIVATE KEY----- deploy docs");
  assert.equal(key.includes("MIIBvQ"), false);
  assert.match(key, /deploy docs/);
});

test("sanitize: bounds enforced", () => {
  assert.throws(() => svc.sanitizeQuery(""), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => svc.sanitizeQuery("x"), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => svc.sanitizeQuery("x".repeat(501)), (e) => e.code === "REQUEST_TOO_LARGE");
  assert.throws(() => svc.sanitizeQuery(42), (e) => e.code === "INVALID_REQUEST");
  // A query that is ONLY a secret redacts to the bare marker (honest, no secret forwarded).
  assert.equal(svc.sanitizeQuery("sk-abc123XYZ89012"), "[redacted]");
});

test("normalizeDdg: abstract + results + topics, internal links dropped, bounded", () => {
  const payload = {
    Heading: "Firebase",
    AbstractURL: "https://en.wikipedia.org/wiki/Firebase",
    AbstractText: "Firebase is a platform. ".repeat(100),
    AbstractSource: "Wikipedia",
    Results: [{ FirstURL: "https://firebase.google.com/docs/cli", Text: "Firebase CLI - official docs" }],
    RelatedTopics: [
      { FirstURL: "https://duckduckgo.com/Firestore", Text: "Firestore - internal" },
      { FirstURL: "https://firebase.google.com/docs/functions", Text: "Cloud Functions docs - official reference" },
      { FirstURL: "not-a-url", Text: "junk" },
    ],
  };
  const out = svc.normalizeDdgResults(payload);
  assert.equal(out.length, 3);
  assert.ok(out.every((r) => !r.url.includes("duckduckgo.com")));
  assert.ok(out.every((r) => r.title.length <= 200 && r.url.length <= 500 && r.snippet.length <= 500));
  assert.ok(out.every((r) => typeof r.domain === "string" && r.domain.length > 0));
  assert.equal(out[0].domain, "en.wikipedia.org");
  // 8-result cap.
  const many = { Results: Array.from({ length: 20 }, (_, i) => ({ FirstURL: `https://example.com/${i}`, Text: `T${i}` })) };
  assert.equal(svc.normalizeDdgResults(many).length, 8);
});

test("normalizeBrave: mapping, bounds, invalid URLs dropped", () => {
  const payload = {
    web: {
      results: [
        { title: "Node.js Docs", url: "https://nodejs.org/docs", description: "Official Node docs" },
        { title: "", url: "https://empty-title.example", description: "x" },
        { title: "Bad", url: "ftp://files.example/x", description: "x" },
      ],
    },
  };
  const out = svc.normalizeBraveResults(payload);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { title: "Node.js Docs", url: "https://nodejs.org/docs", domain: "nodejs.org", snippet: "Official Node docs" });
  assert.deepEqual(svc.normalizeBraveResults({}), []);
});

test("searchWeb: keyed provider used when key present", async () => {
  const brave = { web: { results: [{ title: "Firebase deploy", url: "https://firebase.google.com/docs/cli", description: "Deploy targets" }] } };
  const seen = [];
  const out = await svc.searchWeb("firebase deploy functions", {
    key: "brave-test-key-123",
    fetchFn: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers["X-Subscription-Token"] });
      return { status: 200, text: async () => JSON.stringify(brave) };
    },
  });
  assert.equal(out.provider, "keyed");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].domain, "firebase.google.com");
  assert.ok(seen[0].url.startsWith("https://api.search.brave.com/"));
  assert.equal(seen[0].auth, "brave-test-key-123");
});

test("searchWeb: keyless fallback when no key (no Secret Manager touch)", async () => {
  const ddg = { AbstractURL: "", Results: [{ FirstURL: "https://flutter.dev/docs", Text: "Flutter docs - official" }], RelatedTopics: [] };
  const out = await svc.searchWeb("flutter documentation", {
    key: undefined,
    fetchFn: okFetch(ddg),
  });
  assert.equal(out.provider, "keyless");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].domain, "flutter.dev");
});

test("searchWeb: empty upstream results returned honestly (never fabricated)", async () => {
  const out = await svc.searchWeb("some query", { key: undefined, fetchFn: okFetch({ Results: [], RelatedTopics: [] }) });
  assert.deepEqual(out.results, []);
  assert.equal(out.provider, "keyless");
});

test("searchWeb: keyed auth failure is terminal (no silent fallback)", async () => {
  await assert.rejects(
    svc.searchWeb("q ok", { key: "bad-key-123", fetchFn: okFetch({}, 401) }),
    (e) => e.code === "PROVIDER_AUTH_FAILED"
  );
});

test("searchWeb: keyed transient failure falls back to keyless", async () => {
  const ddg = { Results: [{ FirstURL: "https://example.com/a", Text: "A - b" }], RelatedTopics: [] };
  const out = await svc.searchWeb("q ok", {
    key: "good-key-123",
    fetchFn: async (url) => (String(url).includes("brave") ? { status: 500, text: async () => "{}" } : { status: 200, text: async () => JSON.stringify(ddg) }),
  });
  assert.equal(out.provider, "keyless");
  assert.equal(out.results.length, 1);
});

test("searchWeb: upstream timeout normalized", async () => {
  const err = new Error("aborted");
  err.name = "AbortError";
  await assert.rejects(
    svc.searchWeb("query ok", { key: undefined, fetchFn: async () => { throw err; } }),
    (e) => e.code === "UPSTREAM_UNAVAILABLE" || e.code === "UPSTREAM_TIMEOUT"
  );
});

test("searchWeb: rate-limited upstream normalized", async () => {
  await assert.rejects(
    svc.searchWeb("query ok", { key: undefined, fetchFn: okFetch({}, 429) }),
    (e) => e.code === "PROVIDER_RATE_LIMITED"
  );
});

test("readSearchKey: absent secret yields undefined (keyless path)", async () => {
  svc.setSecretClientForTests({ accessSecretVersion: async () => { throw new Error("not found"); } });
  try {
    assert.equal(await svc.readSearchKey(), undefined);
  } finally {
    svc.setSecretClientForTests(null);
  }
});

test("readSearchKey: present secret returned to backend caller only", async () => {
  svc.setSecretClientForTests({ accessSecretVersion: async () => [{ payload: { data: Buffer.from("brave-live-key") } }] });
  try {
    assert.equal(await svc.readSearchKey(), "brave-live-key");
  } finally {
    svc.setSecretClientForTests(null);
  }
});

// --- Route tests (real app, stubbed auth/db/search) ---

const SRC_FRAG = path.join("functions-subi", "src");

function makeFakeStore(state) {
  const st = state;
  return {
    _state: st,
    collection: (prefix) => ({
      doc: (id) => ({
        get: async () => ({ id, exists: `${prefix}/${id}` in st, data: () => st[`${prefix}/${id}`] }),
      }),
    }),
  };
}

function boot({ user, gateMode = "test" } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(SRC_FRAG)) delete require.cache[k];
  }
  const st = {};
  st["systemConfig/managedAgent"] = { mode: gateMode, testUids: ["u1"] };
  st["systemConfig/subiAccess"] = { enabled: true };
  st["schoolPolicies/s1"] = { roles: { student: { enabled: true }, teacher: { enabled: true } } };
  const fake = makeFakeStore(st);
  const dbPath = require.resolve("../src/db");
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
  const app = require("../src/app");
  const searchSvc = require("../src/services/webSearchService");
  const searchRoute = require("../src/routes/managedSearch");
  searchRoute.clearRateForTests();
  return { app, searchSvc, searchRoute };
}

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

async function postSearch(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/agent/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* non-JSON surface */ }
  return { status: res.status, text, json };
}

const USER = { accountType: "school", uid: "u1", schoolId: "s1", role: "student" };

test("route: success returns bounded results, no leaks", async () => {
  const { app, searchSvc } = boot({ user: USER });
  searchSvc.searchWeb = async () => ({
    results: [
      { title: "Firebase CLI", url: "https://firebase.google.com/docs/cli", domain: "firebase.google.com", snippet: "Deploy targets" },
      { title: "Cloud Functions", url: "https://firebase.google.com/docs/functions", domain: "firebase.google.com", snippet: "Functions docs" },
    ],
    provider: "keyed",
  });
  const server = await listen(app.buildManagedAgentApp());
  try {
    const { status, text, json } = await postSearch(server.address().port, { query: "firebase deploy functions" });
    assert.equal(status, 200);
    assert.equal(json.results.length, 2);
    assert.ok(json.results.every((r) => r.title && r.url && r.domain && typeof r.snippet === "string"));
    for (const banned of ["u1", "test-token", "stack"]) {
      assert.equal(text.includes(banned), false, `leaks ${banned}`);
    }
  } finally {
    server.close();
  }
});

test("route: body validation rejects unknown fields/oversize/empty", async () => {
  const { app, searchSvc } = boot({ user: USER });
  searchSvc.searchWeb = async () => ({ results: [], provider: "keyless" });
  const server = await listen(app.buildManagedAgentApp());
  try {
    const port = server.address().port;
    assert.equal((await postSearch(port, { query: "x", extra: 1 })).status, 400);
    assert.equal((await postSearch(port, { query: "" })).status, 400);
    assert.equal((await postSearch(port, { query: "x".repeat(501) })).status, 413);
    assert.equal((await postSearch(port, {})).status, 400);
  } finally {
    server.close();
  }
});

test("route: unauthenticated rejected, disabled gate rejected", async () => {
  const { app } = boot({ user: null });
  const server = await listen(app.buildManagedAgentApp());
  try {
    assert.equal((await postSearch(server.address().port, { query: "firebase docs" })).status, 401);
  } finally {
    server.close();
  }
  const { app: app2 } = boot({ user: USER, gateMode: "disabled" });
  const server2 = await listen(app2.buildManagedAgentApp());
  try {
    const r = await postSearch(server2.address().port, { query: "firebase docs" });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, "MANAGED_AGENT_DISABLED");
  } finally {
    server2.close();
  }
});

test("route: per-UID rate limit trips after burst", async () => {
  const { app, searchSvc, searchRoute } = boot({ user: USER });
  searchSvc.searchWeb = async () => ({ results: [], provider: "keyless" });
  const server = await listen(app.buildManagedAgentApp());
  try {
    const port = server.address().port;
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await postSearch(port, { query: `firebase docs ${i}` });
      if (r.status === 429) limited++;
      else assert.equal(r.status, 200);
    }
    assert.ok(limited >= 1, "burst must trip the limiter");
    void searchRoute;
  } finally {
    server.close();
  }
});

test("route: upstream failure maps to safe code, no leak", async () => {
  const { app, searchSvc } = boot({ user: USER });
  searchSvc.searchWeb = async () => {
    const e = new Error("boom");
    e.code = "UPSTREAM_TIMEOUT";
    throw e;
  };
  const server = await listen(app.buildManagedAgentApp());
  try {
    const r = await postSearch(server.address().port, { query: "firebase docs" });
    assert.equal(r.status, 504);
    assert.equal(r.json.error.code, "UPSTREAM_TIMEOUT");
    assert.equal(r.text.includes("boom"), false);
  } finally {
    server.close();
  }
});
