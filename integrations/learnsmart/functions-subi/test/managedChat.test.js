// test/managedChat.test.js — Phase 8 managed chat gateway (local only).
// Validator, shared resolver seam, streaming service (fake upstream), and
// chat-app wiring. No live OpenRouter, no Firestore, no deploys.
const test = require("node:test");
const assert = require("node:assert/strict");
const validator = require("../src/services/managedChatValidator");
const effectiveModels = require("../src/services/effectiveModelService");
const chatService = require("../src/services/managedChatService");
const { buildManagedChatApp } = require("../src/app");

function validBody(overrides) {
  return {
    requestId: "r1",
    modelKey: "mdl_test-model",
    messages: [{ role: "user", content: "Hello" }],
    ...(overrides || {}),
  };
}

// ---------- Validator ----------

test("validator accepts minimal text-only body", () => {
  const out = validator.validateChatBody(validBody());
  assert.deepEqual(out, {
    requestId: "r1",
    modelKey: "mdl_test-model",
    messages: [{ role: "user", content: "Hello" }],
  });
});

test("validator rejects unknown top-level fields", () => {
  for (const body of [
    validBody({ upstreamModelId: "x/y" }),
    validBody({ provider: "openrouter" }),
    validBody({ apiKey: "sk-x" }),
    validBody({ schoolId: "s1" }),
    validBody({ role: "student" }),
    validBody({ uid: "u1" }),
    validBody({ monthlyTokenLimit: 5 }),
    validBody({ system: "x" }),
  ]) {
    assert.throws(() => validator.validateChatBody(body), (e) => e.code === "INVALID_REQUEST");
  }
});

test("validator rejects system role and unknown message fields", () => {
  assert.throws(
    () => validator.validateChatBody(validBody({ messages: [{ role: "system", content: "x" }] })),
    (e) => e.code === "INVALID_REQUEST"
  );
  assert.throws(
    () => validator.validateChatBody(validBody({ messages: [{ role: "user", content: "x", extra: 1 }] })),
    (e) => e.code === "INVALID_REQUEST"
  );
});

test("validator rejects bad requestId/modelKey", () => {
  assert.throws(() => validator.validateChatBody(validBody({ requestId: "" })), (e) => e.code === "INVALID_REQUEST");
  assert.throws(
    () => validator.validateChatBody(validBody({ requestId: "x".repeat(65) })),
    (e) => e.code === "INVALID_REQUEST"
  );
  for (const modelKey of ["", "openrouter/free", "upstream/a", "mdl_", "mdl_bad key!"]) {
    assert.throws(() => validator.validateChatBody(validBody({ modelKey })), (e) => e.code === "INVALID_REQUEST");
  }
});

test("validator enforces message bounds", () => {
  assert.throws(() => validator.validateChatBody(validBody({ messages: [] })), (e) => e.code === "INVALID_REQUEST");
  const many = Array.from({ length: 21 }, (_, i) => ({ role: "user", content: `m${i}` }));
  assert.throws(() => validator.validateChatBody(validBody({ messages: many })), (e) => e.code === "INVALID_REQUEST");
  assert.throws(
    () => validator.validateChatBody(validBody({ messages: [{ role: "user", content: "x".repeat(20001) }] })),
    (e) => e.code === "INVALID_REQUEST"
  );
  const big = Array.from({ length: 6 }, () => ({ role: "user", content: "x".repeat(20000) }));
  assert.throws(() => validator.validateChatBody(validBody({ messages: big })), (e) => e.code === "REQUEST_TOO_LARGE");
});

test("validator requires final user text", () => {
  assert.throws(
    () => validator.validateChatBody(validBody({ messages: [{ role: "assistant", content: "hi" }] })),
    (e) => e.code === "INVALID_REQUEST"
  );
  assert.throws(
    () => validator.validateChatBody(validBody({ messages: [{ role: "user", content: "   " }] })),
    (e) => e.code === "INVALID_REQUEST"
  );
});

// ---------- Shared resolver seam ----------

function fakeStore(docs) {
  return {
    collection: () => ({
      doc: (id) => ({
        get: () => Promise.resolve(
          Object.prototype.hasOwnProperty.call(docs, id)
            ? { exists: true, id, data: () => docs[id] }
            : { exists: false }
        ),
      }),
      limit: () => ({ get: () => Promise.resolve({ docs: [] }) }),
    }),
  };
}

test("effective selector uses policy authority after cutover", async () => {
  assert.equal(effectiveModels.MODEL_POLICY_CUTOVER, true);
  const store = fakeStore({});
  const out = await effectiveModels.resolveEffectiveModels(
    { uid: "u1", schoolId: "s1", role: "student" },
    { store, basis: "school_default_enabled" }
  );
  // No policy docs in this empty store: inherit + missing school -> mode
  // reflects the new authority (never "legacy"), models fail closed.
  assert.equal(out.mode, "school_student");
  assert.deepEqual(out.models, []);
});

test("upstream lookup maps known key and rejects stale", async () => {
  const store = {
    collection: () => ({
      doc: (id) => ({
        get: () => {
          if (id === "mdl_ok") {
            return Promise.resolve({
              exists: true,
              id,
              data: () => ({ upstreamModelId: "vendor/model", displayName: "Ok", enabled: true }),
            });
          }
          return Promise.resolve({ exists: false });
        },
      }),
    }),
  };
  assert.equal(await effectiveModels.resolveUpstreamModelId("mdl_ok", { store }), "vendor/model");
  await assert.rejects(effectiveModels.resolveUpstreamModelId("mdl_missing", { store }), (e) => e.code === "MODEL_NOT_AVAILABLE");
  await assert.rejects(effectiveModels.resolveUpstreamModelId("bad key!!", { store }), (e) => e.code === "MODEL_NOT_AVAILABLE");
});

// ---------- Streaming service (fake upstream) ----------

function upstreamFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function fakeUpstreamResponse({ status = 200, chunks = [] }) {
  const bytes = chunks.map((c) => Buffer.from(c, "utf8"));
  const stream = new ReadableStream({
    start(controller) {
      for (const b of bytes) controller.enqueue(b);
      controller.close();
    },
  });
  return { status, headers: { get: () => null }, body: stream };
}

function makeServiceDeps(upstream, seen) {
  return {
    keyResolver: () => Promise.resolve(Buffer.from("sk-live-test-key")),
    fetchImpl: (url, init) => {
      seen.url = url;
      seen.auth = init.headers.Authorization;
      seen.body = JSON.parse(init.body);
      return Promise.resolve(upstream);
    },
  };
}

test("service streams multi-delta text and extracts internal usage", async () => {
  const upstream = fakeUpstreamResponse({
    chunks: [
      `: keep-alive\n\n`,
      upstreamFrame({ model: "vendor/m", choices: [{ delta: { content: "Hel" } }] }),
      upstreamFrame({ choices: [{ delta: { content: "lo" } }] }),
      `data: not-json{\n\n`,
      upstreamFrame({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 34 } }),
      `data: [DONE]\n\n`,
    ],
  });
  const seen = {};
  const deltas = [];
  const usage = await chatService.streamManagedChat({
    requestId: "r1",
    upstreamModelId: "vendor/m",
    messages: [{ role: "user", content: "Hi" }],
    onDelta: async (t) => deltas.push(t),
    ...makeServiceDeps(upstream, seen),
  });
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 34 });
  assert.equal(seen.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen.auth, "Bearer sk-live-test-key");
  assert.equal(seen.body.model, "vendor/m");
  assert.equal(seen.body.stream, true);
  assert.ok(!JSON.stringify(seen.body).includes("sk-live-test-key"), "key must not be in body");
  // Deltas carry text only — no upstream identity, no key material.
  assert.ok(!deltas.join("").includes("vendor/m"));
});

test("service maps provider errors safely", async () => {
  for (const [status, code] of [[401, "PROVIDER_AUTH_FAILED"], [403, "PROVIDER_AUTH_FAILED"], [429, "PROVIDER_RATE_LIMITED"], [500, "PROVIDER_UNAVAILABLE"], [502, "PROVIDER_UNAVAILABLE"]]) {
    const seen = {};
    await assert.rejects(
      chatService.streamManagedChat({
        requestId: "r1",
        upstreamModelId: "vendor/m",
        messages: [{ role: "user", content: "Hi" }],
        onDelta: async () => {},
        ...makeServiceDeps(fakeUpstreamResponse({ status, chunks: [] }), seen),
      }),
      (e) => e.code === code
    );
  }
});

test("service maps network failure and empty streams", async () => {
  const failing = {
    keyResolver: () => Promise.resolve(Buffer.from("k")),
    fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
  };
  await assert.rejects(
    chatService.streamManagedChat({ requestId: "r1", upstreamModelId: "m", messages: [{ role: "user", content: "x" }], onDelta: async () => {}, ...failing }),
    (e) => e.code === "PROVIDER_UNAVAILABLE"
  );
  const empty = {
    keyResolver: () => Promise.resolve(Buffer.from("k")),
    fetchImpl: () => Promise.resolve(fakeUpstreamResponse({ chunks: [": nothing\n\n"] })),
  };
  await assert.rejects(
    chatService.streamManagedChat({ requestId: "r1", upstreamModelId: "m", messages: [{ role: "user", content: "x" }], onDelta: async () => {}, ...empty }),
    (e) => e.code === "PROVIDER_UNAVAILABLE"
  );
});

test("service surfaces secret/config failures without key material", async () => {
  const mk = (err) => ({ keyResolver: () => Promise.reject(err), fetchImpl: () => { throw new Error("must not fetch"); } });
  const e1 = Object.assign(new Error("x"), { code: "AI_NOT_CONFIGURED" });
  await assert.rejects(
    chatService.streamManagedChat({ requestId: "r", upstreamModelId: "m", messages: [{ role: "user", content: "x" }], onDelta: async () => {}, ...mk(e1) }),
    (e) => e.code === "AI_NOT_CONFIGURED"
  );
  const e2 = Object.assign(new Error("x"), { code: "SECRET_UNAVAILABLE" });
  await assert.rejects(
    chatService.streamManagedChat({ requestId: "r", upstreamModelId: "m", messages: [{ role: "user", content: "x" }], onDelta: async () => {}, ...mk(e2) }),
    (e) => e.code === "SECRET_UNAVAILABLE"
  );
});

test("service sends reserved max_tokens and awaits accepted callback", async () => {
  const order = [];
  const upstream = fakeUpstreamResponse({
    chunks: [
      upstreamFrame({ choices: [{ delta: { content: "Hi" } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
      `data: [DONE]\n\n`,
    ],
  });
  const seen = {};
  const usage = await chatService.streamManagedChat({
    requestId: "r1",
    upstreamModelId: "vendor/m",
    messages: [{ role: "user", content: "Hi" }],
    maxOutputTokens: 512,
    onProviderAccepted: async () => {
      order.push("accepted");
    },
    onDelta: async (t) => {
      order.push(`delta:${t}`);
    },
    ...makeServiceDeps(upstream, seen),
  });
  assert.deepEqual(usage, { inputTokens: 9, outputTokens: 3 });
  assert.equal(seen.body.max_tokens, 512);
  assert.deepEqual(order, ["accepted", "delta:Hi"]);
});

test("service omits max_tokens when no reservation budget given", async () => {
  const upstream = fakeUpstreamResponse({ chunks: [`data: [DONE]\n\n`] });
  const seen = {};
  await chatService.streamManagedChat({
    requestId: "r1",
    upstreamModelId: "vendor/m",
    messages: [{ role: "user", content: "Hi" }],
    onDelta: async () => {},
    ...makeServiceDeps(upstream, seen),
  });
  assert.equal("max_tokens" in seen.body, false);
});

test("cancel after accept carries partial usage with providerAccepted", async () => {
  const controller = new AbortController();
  const slow = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(upstreamFrame({
        choices: [{ delta: { content: "a" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), "utf8"));
    },
  });
  const deps = {
    keyResolver: () => Promise.resolve(Buffer.from("k")),
    fetchImpl: () => Promise.resolve({ status: 200, headers: { get: () => null }, body: slow }),
  };
  const p = chatService.streamManagedChat({
    requestId: "r",
    upstreamModelId: "m",
    messages: [{ role: "user", content: "x" }],
    signal: controller.signal,
    onDelta: async () => {
      controller.abort();
    },
    ...deps,
  });
  await assert.rejects(p, (e) => (
    e.code === "CANCELLED" &&
    e.providerAccepted === true &&
    e.usage.inputTokens === 10 &&
    e.usage.outputTokens === 5
  ));
});

test("pre-accept failures are marked providerAccepted=false", async () => {
  const deps = {
    keyResolver: () => Promise.resolve(Buffer.from("k")),
    fetchImpl: () => Promise.resolve({ status: 401, headers: { get: () => null }, body: null }),
  };
  await assert.rejects(
    chatService.streamManagedChat({
      requestId: "r",
      upstreamModelId: "m",
      messages: [{ role: "user", content: "x" }],
      onDelta: async () => {},
      ...deps,
    }),
    (e) => e.code === "PROVIDER_AUTH_FAILED" && e.providerAccepted === false
  );
});

test("dispatch callback runs after key resolution and before fetch", async () => {
  const order = [];
  const upstream = fakeUpstreamResponse({
    chunks: [
      upstreamFrame({ choices: [{ delta: { content: "Hi" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
      `data: [DONE]\n\n`,
    ],
  });
  const deps = {
    keyResolver: () => {
      order.push("key");
      return Promise.resolve(Buffer.from("k"));
    },
    fetchImpl: (url, init) => {
      order.push("fetch");
      assert.equal(JSON.parse(init.body).max_tokens, undefined);
      return Promise.resolve(upstream);
    },
  };
  const usage = await chatService.streamManagedChat({
    requestId: "r1",
    upstreamModelId: "m",
    messages: [{ role: "user", content: "Hi" }],
    onBeforeProviderDispatch: async () => {
      order.push("dispatch");
    },
    onDelta: async () => {},
    ...deps,
  });
  assert.deepEqual(order, ["key", "dispatch", "fetch"]);
  assert.deepEqual(usage, { inputTokens: 4, outputTokens: 2 });
});

test("dispatch callback failure prevents fetch entirely", async () => {
  let fetched = false;
  const deps = {
    keyResolver: () => Promise.resolve(Buffer.from("k")),
    fetchImpl: () => {
      fetched = true;
      return Promise.resolve(fakeUpstreamResponse({ chunks: [] }));
    },
  };
  await assert.rejects(
    chatService.streamManagedChat({
      requestId: "r1",
      upstreamModelId: "m",
      messages: [{ role: "user", content: "Hi" }],
      onBeforeProviderDispatch: async () => {
        const err = new Error("quota store down");
        err.code = "UNAVAILABLE";
        throw err;
      },
      onDelta: async () => {},
      ...deps,
    }),
    (e) => e.code === "UNAVAILABLE"
  );
  assert.equal(fetched, false);
});

test("pre-fetch abort after dispatch callback surfaces DISPATCH_ABORTED", async () => {
  const controller = new AbortController();
  controller.abort(); // already aborted before fetch would run
  let fetched = false;
  const deps = {
    keyResolver: () => Promise.resolve(Buffer.from("k")),
    fetchImpl: () => {
      fetched = true;
      return Promise.resolve(fakeUpstreamResponse({ chunks: [] }));
    },
  };
  let dispatched = false;
  await assert.rejects(
    chatService.streamManagedChat({
      requestId: "r1",
      upstreamModelId: "m",
      messages: [{ role: "user", content: "Hi" }],
      signal: controller.signal,
      onBeforeProviderDispatch: async () => {
        dispatched = true;
      },
      onDelta: async () => {},
      ...deps,
    }),
    (e) => e.code === "CANCELLED" && e.providerAccepted === false
  );
  // Pre-aborted signal is caught before dispatch (no wasted risk boundary).
  assert.equal(dispatched, false);
  assert.equal(fetched, false);
});

test("service aborts on caller cancel with CANCELLED", async () => {
  const controller = new AbortController();
  const slow = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(upstreamFrame({ choices: [{ delta: { content: "a" } }] }), "utf8"));
    },
  });
  const deps = {
    keyResolver: () => Promise.resolve(Buffer.from("k")),
    fetchImpl: () => Promise.resolve({ status: 200, headers: { get: () => null }, body: slow }),
  };
  const deltas = [];
  const p = chatService.streamManagedChat({
    requestId: "r",
    upstreamModelId: "m",
    messages: [{ role: "user", content: "x" }],
    signal: controller.signal,
    onDelta: async (t) => {
      deltas.push(t);
      controller.abort();
    },
    ...deps,
  });
  await assert.rejects(p, (e) => e.code === "CANCELLED");
});

test("service zero-fills the key buffer", async () => {
  const key = Buffer.from("sk-wipe-me");
  const deps = {
    keyResolver: () => Promise.resolve(key),
    fetchImpl: () => Promise.resolve(fakeUpstreamResponse({ chunks: [`data: [DONE]\n\n`] })),
  };
  await chatService.streamManagedChat({
    requestId: "r",
    upstreamModelId: "m",
    messages: [{ role: "user", content: "x" }],
    onDelta: async () => {},
    ...deps,
  });
  assert.ok(key.every((b) => b === 0), "key buffer must be wiped");
});

// ---------- App wiring (local only) ----------

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

test("chat app requires auth (401 without token)", async () => {
  const s = await listen(buildManagedChatApp());
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    assert.equal(r.status, 401);
  } finally {
    s.close();
  }
});

test("chat app rejects oversized bodies with REQUEST_TOO_LARGE", async () => {
  const s = await listen(buildManagedChatApp());
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ messages: [{ role: "user", content: "x".repeat(600 * 1024) }] })),
    });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: { code: "REQUEST_TOO_LARGE" } });
  } finally {
    s.close();
  }
});
