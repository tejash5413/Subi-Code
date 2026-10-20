// functions-subi/src/services/modelCatalogService.js
// Superadmin-only OpenRouter catalogue fetch + sanitization (Phase 4).
//
// BOUNDARY: may use aiConnectionService.resolveActiveManagedKey() ONLY.
// Never imports secretService directly. Never touches Firestore. Never
// logs/returns/persists key material. Runs under subi-managed-runtime,
// which already holds secretAccessor — admin runtime gains nothing.
//
// DI: fetchCatalog(deps) accepts { keyResolver, fetchImpl } for fakes.

const aiConnectionService = require("./aiConnectionService");

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_MODELS = 1000;

const INPUT_MODALITIES = new Set(["text", "image", "file", "audio"]);
const OUTPUT_MODALITIES = new Set(["text", "image", "audio"]);

function defaultDeps() {
  return {
    keyResolver: () => aiConnectionService.resolveActiveManagedKey(),
    fetchImpl: fetch,
  };
}

function cleanStr(value, max) {
  if (typeof value !== "string") return null;
  const v = value.trim().slice(0, max);
  return v ? v : null;
}

function cleanModalities(value, allow) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const m = v.trim().toLowerCase();
    if (allow.has(m) && !out.includes(m)) out.push(m);
    if (out.length >= 10) break;
  }
  return out;
}

function cleanPrice(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim().slice(0, 32);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return s;
}

// OpenRouter `created` is unix seconds (10 digits). Normalize to ms epoch
// (number) or null. Accepts sec/ms numeric, numeric strings, ISO strings,
// and Date instances. Missing/invalid never drops the model.
function cleanCreated(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value >= 1e12) return Math.floor(value); // already ms
    if (value >= 1e9) return Math.floor(value * 1000); // unix sec → ms
    return null;
  }
  if (typeof value === "string") {
    const s = value.trim().slice(0, 64);
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return cleanCreated(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  return null;
}

function sanitizeModel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const upstreamModelId = cleanStr(raw.id, 200);
  if (!upstreamModelId) return null;
  const arch = raw.architecture && typeof raw.architecture === "object" ? raw.architecture : {};
  const supported = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  const toolCalling = supported.some((p) => String(p).toLowerCase() === "tools");
  const contextLength = Number.isSafeInteger(raw.context_length) && raw.context_length > 0
    ? raw.context_length : null;
  const aliasTarget =
    raw.alias_target && typeof raw.alias_target === "object"
      ? {
          slug: cleanStr(raw.alias_target.slug, 200),
          name: cleanStr(raw.alias_target.name, 200),
        }
      : null;
  const expires = cleanStr(raw.expiration_date, 64);
  const pricing = raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {};
  return {
    upstreamModelId,
    name: cleanStr(raw.name, 200) || upstreamModelId,
    description: cleanStr(raw.description, 500),
    contextLength,
    pricing: {
      input: cleanPrice(pricing.prompt),
      output: cleanPrice(pricing.completion),
    },
    capabilities: {
      inputModalities: cleanModalities(arch.input_modalities, INPUT_MODALITIES),
      outputModalities: cleanModalities(arch.output_modalities, OUTPUT_MODALITIES),
      toolCalling,
    },
    deprecated: expires ? new Date(expires).getTime() <= Date.now() : false,
    aliasTarget,
    created: cleanCreated(raw.created ?? raw.created_at ?? raw.createdAt),
  };
}

// True bounded body reader: aborts once MAX_BODY_BYTES is exceeded instead
// of buffering an unbounded response first.
async function readBoundedBody(res) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      const err = new Error("catalog too large");
      err.code = "UPSTREAM_INVALID";
      throw err;
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value ? value.byteLength || value.length || 0 : 0;
      if (bytes > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch (_) {
          // ignore cancel failure; the size error below is authoritative
        }
        const err = new Error("catalog too large");
        err.code = "UPSTREAM_INVALID";
        throw err;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {
      // ignore release failure on already-cancelled readers
    }
  }
  const buf = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  return buf.toString("utf8");
}

// Ephemeral convenience cache (sanitized items only, ~5 min). Never a
// security authority; approval always reads live approvedModels docs.
let cache = { at: 0, items: null };
const CACHE_TTL_MS = 5 * 60 * 1000;
function getCached() {
  if (cache.items && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;
  return null;
}
function setCached(items) {
  cache = { at: Date.now(), items };
}
function clearCacheForTests() {
  cache = { at: 0, items: null };
}

async function fetchCatalog(deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  // Mutation paths (school/individual assignment saves) pass
  // { refresh: true } to bypass the display cache: the existence check in
  // ensureCatalogueModels must run against the live catalogue, otherwise a
  // model that is visible in Superadmin (fresh display fetch) but missing
  // from this instance's 5-minute cache fails the whole SAVE as
  // "unknown catalogue model" while the UI still shows it checked.
  // Read paths keep the TTL. Test fakes (fetchImpl) always bypass.
  const bypass = !!(deps && (deps.fetchImpl || deps.refresh));
  const cached = !bypass ? getCached() : null;
  if (cached) return { models: cached, cached: true };

  let key;
  try {
    key = await d.keyResolver();
  } catch (err) {
    if (err && (err.code === "AI_NOT_CONFIGURED" || err.code === "SECRET_UNAVAILABLE")) throw err;
    const e = new Error("secret unavailable");
    e.code = "SECRET_UNAVAILABLE";
    throw e;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await d.fetchImpl(MODELS_URL, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${key.toString("utf8")}` },
        signal: controller.signal,
      });
    } catch (_) {
      const err = new Error("upstream timeout");
      err.code = "UPSTREAM_TIMEOUT";
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error("upstream auth failed");
      err.code = "AI_VALIDATION_FAILED";
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error("upstream unavailable");
      err.code = "UPSTREAM_UNAVAILABLE";
      throw err;
    }
    const contentType = String((res.headers && res.headers.get("content-type")) || "");
    if (contentType && !contentType.includes("application/json")) {
      const err = new Error("unexpected content type");
      err.code = "UPSTREAM_INVALID";
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readBoundedBody(res));
    } catch (e) {
      if (e && e.code === "UPSTREAM_INVALID") throw e;
      const err = new Error("invalid upstream body");
      err.code = "UPSTREAM_INVALID";
      throw err;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) {
      const err = new Error("unexpected upstream shape");
      err.code = "UPSTREAM_INVALID";
      throw err;
    }
    if (parsed.data.length > MAX_CATALOG_MODELS) {
      const err = new Error("catalog exceeds safe bound");
      err.code = "UPSTREAM_INVALID";
      throw err;
    }
    const models = [];
    for (const raw of parsed.data) {
      const item = sanitizeModel(raw);
      if (item) models.push(item);
      if (models.length >= MAX_CATALOG_MODELS) break;
    }
    setCached(models);
    return { models, cached: false };
  } finally {
    clearTimeout(timer);
    try {
      if (Buffer.isBuffer(key)) key.fill(0);
    } catch (_) {
      // best-effort wipe only
    }
  }
}

module.exports = {
  fetchCatalog,
  sanitizeModel,
  cleanCreated,
  clearCacheForTests,
  MODELS_URL,
  MAX_CATALOG_MODELS,
};
