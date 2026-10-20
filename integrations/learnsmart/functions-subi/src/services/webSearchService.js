// functions-subi/src/services/webSearchService.js
// Backend-proxied public web search (Phase 18 certification).
//
// The VS Code extension never holds search credentials and never calls a
// search API directly: it POSTs { query } to /agent/search (Firebase ID
// token auth + managed-agent operational gate), and THIS service performs
// the upstream request server-side.
//
// Upstream selection (no code change to switch):
//   1. Keyed provider (Brave-compatible web-search API) when the
//      SUBI_WEB_SEARCH_KEY secret is provisioned in Secret Manager and the
//      runtime service account can access it. Key material never leaves
//      this module: never logged, never serialized to HTTP, never cached
//      beyond the request.
//   2. Keyless public fallback: DuckDuckGo Instant Answer (official JSON
//      API, no key, no scraping, no cookies). Thinner for docs queries,
//      but real and bounded.
//
// Both paths normalize to [{ title, url, domain, snippet }] (bounded,
// max 8). Empty upstream results are returned honestly as [] — never
// fabricated.
//
// BOUNDARY: pure network + optional Secret Manager read. No Firestore, no
// quota writes, no legacy website AI, no OPENROUTER secret access.

const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "learnsmart-c2a7e";

// Allowlisted search credential ONLY. Never accept a secret name/id from
// request input. Absent secret ⇒ keyless fallback (never a throw).
const SEARCH_SECRET_ID = "SUBI_WEB_SEARCH_KEY";
const SEARCH_KEY_VERSION = "latest";

const MAX_QUERY_CHARS = 500;
const MIN_QUERY_CHARS = 2;
const MAX_RESULTS = 8;
const UPSTREAM_TIMEOUT_MS = 8000;
const TITLE_CHARS = 200;
const URL_CHARS = 500;
const SNIPPET_CHARS = 500;

// Secret-shaped material stripped from queries before any upstream request.
// Queries carry technical errors, never credentials; anything shaped like
// one is redacted, and a query left too short is rejected.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /xox[bpas]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /ya29\.[A-Za-z0-9_-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[A-Za-z0-9_-]*\.(?:pem|key|pfx|p12)(?=[\s"'`]|$)/gi,
  /(?:password|passwd|pwd|api[-_ ]?key|secret|token|authorization)\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\.env\b[^\n]{0,200}/gi,
];

function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function invalidRequest(message) {
  coded(message, "INVALID_REQUEST");
}

function tooLarge(message) {
  const err = new Error(message);
  err.code = "REQUEST_TOO_LARGE";
  throw err;
}

/** Redact secret-shaped material; throws INVALID_REQUEST when unusable. */
function sanitizeQuery(raw) {
  if (typeof raw !== "string") invalidRequest("invalid query");
  if (raw.length > MAX_QUERY_CHARS) tooLarge("query exceeds budget");
  let out = raw;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  out = out.trim().replace(/\s+/g, " ");
  if (out.length < MIN_QUERY_CHARS) invalidRequest("invalid query");
  return out.slice(0, MAX_QUERY_CHARS);
}

function domainOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/\.$/, "").slice(0, 253);
  } catch {
    return "";
  }
}

function boundText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Drop DDG-internal/empty links; keep real external http(s) results only. */
function normalizeDdgResults(payload) {
  const out = [];
  const push = (title, url, snippet) => {
    if (out.length >= MAX_RESULTS) return;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    const domain = domainOf(url);
    if (!domain || /(^|\.)duckduckgo\.com$/i.test(domain)) return;
    const t = boundText(title, TITLE_CHARS);
    if (!t) return;
    out.push({
      title: t,
      url: url.slice(0, URL_CHARS),
      domain,
      snippet: boundText(snippet, SNIPPET_CHARS),
    });
  };
  if (payload && typeof payload === "object") {
    if (typeof payload.AbstractURL === "string" && payload.AbstractURL && typeof payload.AbstractText === "string" && payload.AbstractText) {
      push(payload.Heading || payload.AbstractSource || domainOf(payload.AbstractURL), payload.AbstractURL, payload.AbstractText);
    }
    for (const r of Array.isArray(payload.Results) ? payload.Results : []) {
      push(r && r.Text ? String(r.Text).split(" - ")[0] : "", r && r.FirstURL, r && r.Text);
    }
    for (const t of Array.isArray(payload.RelatedTopics) ? payload.RelatedTopics : []) {
      if (t && typeof t === "object" && t.FirstURL) {
        push(t.Text ? String(t.Text).split(" - ")[0] : "", t.FirstURL, t.Text);
      } else if (t && typeof t === "object" && Array.isArray(t.Topics)) {
        for (const sub of t.Topics) {
          if (sub && sub.FirstURL) push(sub.Text ? String(sub.Text).split(" - ")[0] : "", sub.FirstURL, sub.Text);
        }
      }
    }
  }
  return out;
}

function normalizeBraveResults(payload) {
  const out = [];
  const list = payload && typeof payload === "object" && payload.web && Array.isArray(payload.web.results)
    ? payload.web.results
    : [];
  for (const r of list) {
    if (out.length >= MAX_RESULTS) break;
    if (!r || typeof r !== "object") continue;
    if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
    const domain = domainOf(r.url);
    if (!domain) continue;
    const title = boundText(r.title, TITLE_CHARS);
    if (!title) continue;
    out.push({
      title,
      url: r.url.slice(0, URL_CHARS),
      domain,
      snippet: boundText(r.description, SNIPPET_CHARS),
    });
  }
  return out;
}

async function fetchJson(url, { headers, fetchFn, timeoutMs }) {
  const impl = fetchFn || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await impl(url, { method: "GET", headers, signal: controller.signal });
    const status = res && typeof res.status === "number" ? res.status : 0;
    if (status === 429) coded("upstream rate limited", "PROVIDER_RATE_LIMITED");
    if (status === 401 || status === 403) coded("upstream rejected credentials", "PROVIDER_AUTH_FAILED");
    if (status < 200 || status >= 300) coded(`upstream status ${status}`, "UPSTREAM_UNAVAILABLE");
    const text = await res.text();
    if (text.length > 512 * 1024) coded("upstream response too large", "UPSTREAM_INVALID");
    try {
      return JSON.parse(text);
    } catch {
      coded("upstream returned non-JSON", "UPSTREAM_INVALID");
    }
  } catch (err) {
    if (err && (err.code === "PROVIDER_RATE_LIMITED" || err.code === "PROVIDER_AUTH_FAILED" || err.code === "UPSTREAM_UNAVAILABLE" || err.code === "UPSTREAM_INVALID")) {
      throw err;
    }
    if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
      coded("upstream timeout", "UPSTREAM_TIMEOUT");
    }
    coded("upstream unreachable", "UPSTREAM_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
  coded("unreachable", "INTERNAL");
}

// Injectable Secret Manager client for unit tests. Production uses ADC.
let secretClientOverride = null;
function setSecretClientForTests(client) {
  secretClientOverride = client || null;
}

function secretClient() {
  if (secretClientOverride) return secretClientOverride;
  return new SecretManagerServiceClient();
}

/** Returns the keyed-provider key or undefined (absent ⇒ keyless path). */
async function readSearchKey() {
  try {
    const [response] = await secretClient().accessSecretVersion({
      name: `projects/${PROJECT_ID}/secrets/${SEARCH_SECRET_ID}/versions/${SEARCH_KEY_VERSION}`,
    });
    const data = response && response.payload && response.payload.data;
    const key = Buffer.isBuffer(data) ? data.toString("utf8").trim() : String(data || "").trim();
    return key.length >= 8 ? key : undefined;
  } catch {
    return undefined;
  }
}

async function searchKeyed(query, { fetchFn, key }) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&text_decorations=0`;
  // Key travels in the upstream Authorization-equivalent header only; never
  // logged, never stored, never returned.
  const payload = await fetchJson(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    fetchFn,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  });
  return normalizeBraveResults(payload);
}

async function searchKeyless(query, { fetchFn }) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const payload = await fetchJson(url, {
    headers: { Accept: "application/json", "User-Agent": "SUBI-docs-search/1.0" },
    fetchFn,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  });
  return normalizeDdgResults(payload);
}

/**
 * Search the public web for one sanitized query.
 * Returns { results, provider } where provider is 'keyed' | 'keyless'.
 * Empty upstream results are returned honestly as []. Never fabricated.
 */
async function searchWeb(rawQuery, deps = {}) {
  const query = sanitizeQuery(rawQuery);
  const key = deps.key !== undefined ? deps.key : await readSearchKey();
  if (typeof key === "string" && key.length >= 8) {
    try {
      const results = await searchKeyed(query, { fetchFn: deps.fetchFn, key });
      return { results, provider: "keyed" };
    } catch (err) {
      // Keyed failure (auth/quota excluded — those are terminal) falls back
      // to the keyless public API rather than failing the recovery flow.
      if (err && (err.code === "PROVIDER_AUTH_FAILED")) throw err;
      const results = await searchKeyless(query, { fetchFn: deps.fetchFn });
      return { results, provider: "keyless" };
    }
  }
  const results = await searchKeyless(query, { fetchFn: deps.fetchFn });
  return { results, provider: "keyless" };
}

module.exports = {
  SEARCH_SECRET_ID,
  MAX_QUERY_CHARS,
  MAX_RESULTS,
  UPSTREAM_TIMEOUT_MS,
  sanitizeQuery,
  domainOf,
  normalizeDdgResults,
  normalizeBraveResults,
  searchWeb,
  readSearchKey,
  setSecretClientForTests,
};
