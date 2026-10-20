// test/modelCatalog.test.js — Phase 4 catalogue tests (fakes only, no network).
const test = require("node:test");
const assert = require("node:assert/strict");

const catalog = require("../src/services/modelCatalogService");

function fakeFetch(handler) {
  return async () => handler();
}
function jsonRes(status, body, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : null) },
    async text() {
      return text;
    },
    body: null,
  };
}
function streamRes(status, chunks) {
  return {
    status,
    headers: { get: () => "application/json" },
    body: {
      getReader() {
        let i = 0;
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            const v = chunks[i++];
            return { done: false, value: Buffer.from(v) };
          },
          releaseLock() {},
          async cancel() {},
        };
      },
    },
  };
}
const goodItem = {
  id: "anthropic/claude-sonnet-4",
  name: "Claude Sonnet 4",
  description: "Frontier model",
  context_length: 200000,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools", "temperature", "weird-param"],
};
const deps = (fetchImpl) => ({
  keyResolver: async () => Buffer.from("fake-key"),
  fetchImpl,
});

test('context ceiling never coerces malformed metadata into a smaller bound', () => {
  for (const context_length of [true, false, 123.7, '123.7', -1, 0, null, Infinity, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(catalog.sanitizeModel({ id: 'x/y', context_length }).contextLength, null);
  }
  assert.equal(catalog.sanitizeModel({ id: 'x/y', context_length: 8192 }).contextLength, 8192);
});

test("AI not configured propagates", async () => {
  const err = await catalog
    .fetchCatalog({ keyResolver: async () => { throw Object.assign(new Error("x"), { code: "AI_NOT_CONFIGURED" }); }, fetchImpl: fakeFetch(() => jsonRes(200, {})) })
    .then(() => null, (e) => e);
  assert.equal(err.code, "AI_NOT_CONFIGURED");
});

test("success sanitizes + drops unknown fields", async () => {
  catalog.clearCacheForTests();
  const out = await catalog.fetchCatalog(
    deps(fakeFetch(() => jsonRes(200, { data: [{ ...goodItem, evil: 1, pricing: { prompt: "0.000003", completion: "0.000015", request: "9" } }] })))
  );
  assert.equal(out.models.length, 1);
  const m = out.models[0];
  assert.equal(m.upstreamModelId, "anthropic/claude-sonnet-4");
  assert.deepEqual(m.capabilities.inputModalities, ["text", "image"]);
  assert.equal(m.capabilities.toolCalling, true);
  assert.equal(m.evil, undefined);
  assert.deepEqual(m.pricing, { input: "0.000003", output: "0.000015" });
  // malformed prices are nulled, never passed through raw
  const bad = catalog.sanitizeModel({ id: "x/y", pricing: { prompt: "free", completion: "-5" } });
  assert.deepEqual(bad.pricing, { input: null, output: null });
});

test("401/403 → AI_VALIDATION_FAILED; 500 → UPSTREAM_UNAVAILABLE", async () => {
  catalog.clearCacheForTests();
  for (const [status, code] of [[401, "AI_VALIDATION_FAILED"], [403, "AI_VALIDATION_FAILED"], [500, "UPSTREAM_UNAVAILABLE"]]) {
    const err = await catalog
      .fetchCatalog(deps(fakeFetch(() => jsonRes(status, { error: {} }))))
      .then(() => null, (e) => e);
    assert.equal(err.code, code, String(status));
  }
});

test("timeout, malformed JSON, missing data, bad content-type", async () => {
  catalog.clearCacheForTests();
  const timeoutErr = await catalog
    .fetchCatalog(deps(async () => { throw new Error("boom"); }))
    .then(() => null, (e) => e);
  assert.equal(timeoutErr.code, "UPSTREAM_TIMEOUT");
  const badJson = await catalog
    .fetchCatalog(deps(fakeFetch(() => jsonRes(200, "not json{"))))
    .then(() => null, (e) => e);
  assert.equal(badJson.code, "UPSTREAM_INVALID");
  const noData = await catalog
    .fetchCatalog(deps(fakeFetch(() => jsonRes(200, { models: [] }))))
    .then(() => null, (e) => e);
  assert.equal(noData.code, "UPSTREAM_INVALID");
  const badType = await catalog
    .fetchCatalog(deps(fakeFetch(() => jsonRes(200, { data: [] }, "text/html"))))
    .then(() => null, (e) => e);
  assert.equal(badType.code, "UPSTREAM_INVALID");
});

test("oversized streamed body rejected", async () => {
  catalog.clearCacheForTests();
  const big = "x".repeat(3 * 1024 * 1024);
  const err = await catalog
    .fetchCatalog(deps(fakeFetch(() => streamRes(200, [big]))))
    .then(() => null, (e) => e);
  assert.equal(err.code, "UPSTREAM_INVALID");
});

test("too many models → error, not truncation", async () => {
  catalog.clearCacheForTests();
  const data = Array.from({ length: 1001 }, (_, i) => ({ id: `m/${i}`, name: `M ${i}` }));
  const err = await catalog
    .fetchCatalog(deps(fakeFetch(() => jsonRes(200, { data }))))
    .then(() => null, (e) => e);
  assert.equal(err.code, "UPSTREAM_INVALID");
});

test("long strings truncated; unknown capabilities dropped; alias/deprecated", async () => {
  const out = catalog.sanitizeModel({
    id: "x/y",
    name: "n".repeat(500),
    description: "d".repeat(900),
    architecture: { input_modalities: ["text", "telepathy"], output_modalities: ["hologram"] },
    expiration_date: "2000-01-01T00:00:00Z",
    alias_target: { slug: "x/z", name: "Zed" },
  });
  assert.equal(out.name.length, 200);
  assert.equal(out.description.length, 500);
  assert.deepEqual(out.capabilities.inputModalities, ["text"]);
  assert.deepEqual(out.capabilities.outputModalities, []);
  assert.equal(out.deprecated, true);
  assert.deepEqual(out.aliasTarget, { slug: "x/z", name: "Zed" });
  assert.equal(catalog.sanitizeModel(null), null);
  assert.equal(catalog.sanitizeModel({ name: "no-id" }), null);
});

test("key never in output or errors", async () => {
  catalog.clearCacheForTests();
  const out = await catalog.fetchCatalog(deps(fakeFetch(() => jsonRes(200, { data: [goodItem] }))));
  assert.equal(JSON.stringify(out).includes("fake-key"), false);
  const err = await catalog
    .fetchCatalog(deps(fakeFetch(() => jsonRes(500, { error: { message: "fake-key?" } }))))
    .then(() => null, (e) => e);
  assert.equal(JSON.stringify(err).includes("fake-key"), false);
});
