// functions-subi/src/routes/managedSearch.js
// Backend-proxied public web search (Phase 18 certification).
//
// POST /agent/search { query } → { results: [{ title, url, domain, snippet }] }
//
// Same trust posture as the agent gateway:
//   - requireAuth({ managedOnly: true }) → trusted req.subi (never body uid)
//   - managed-agent operational gate (disabled/test/enabled) — TEST rollout
//     preserved; no general-production enable here
//   - SUBI access check (resolveSubiAccess) so disabled accounts cannot use
//     backend egress as an oracle
//   - bounded in-memory per-UID rate limit (abuse guard for TEST mode)
//
// The extension never holds search credentials. Queries are sanitized
// (secret-shaped material redacted, bounds enforced) before any upstream
// request. Logs carry counts/codes only — never query text, results, UIDs,
// keys, or tokens.
//
// BOUNDARY: no Firestore writes, no quota writes, no provider secrets other
// than the optional search key inside webSearchService, no legacy website
// AI, no OPENROUTER secret access.

const express = require("express");
const accessService = require("../services/accessService");
const agentConfig = require("../services/managedAgentConfigService");
const webSearch = require("../services/webSearchService");
const { requireAuth } = require("../middleware/auth");
const { errorBody, safeCode, statusFor } = require("../utils/redact");
const { info: logInfo, warn: logWarn } = require("../utils/structuredLogger");

const MAX_BODY_QUERY_CHARS = 500;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 10;
const RATE_MAX_TRACKED_UIDS = 2000;

// uid-hash → timestamps. In-memory only (TEST-mode abuse guard, not quota
// authority). Bounded so the table itself cannot grow without limit.
const rateBuckets = new Map();

function rateLimited(uidHash) {
  const now = Date.now();
  // Opportunistic prune on a bounded sample to avoid unbounded iteration.
  if (rateBuckets.size > RATE_MAX_TRACKED_UIDS) {
    for (const [k, stamps] of rateBuckets) {
      if (stamps.length === 0 || stamps[stamps.length - 1] < now - RATE_WINDOW_MS) rateBuckets.delete(k);
      if (rateBuckets.size <= RATE_MAX_TRACKED_UIDS) break;
    }
  }
  const stamps = (rateBuckets.get(uidHash) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (stamps.length >= RATE_MAX_PER_WINDOW) {
    rateBuckets.set(uidHash, stamps);
    return true;
  }
  stamps.push(now);
  rateBuckets.set(uidHash, stamps);
  return false;
}

function clearRateForTests() {
  rateBuckets.clear();
}

function validateSearchBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const err = new Error("invalid request body");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  for (const k of Object.keys(body)) {
    if (k !== "query") {
      const err = new Error("unknown field");
      err.code = "INVALID_REQUEST";
      throw err;
    }
  }
  if (typeof body.query !== "string" || body.query.length === 0 || body.query.length > MAX_BODY_QUERY_CHARS) {
    const err = new Error("invalid query");
    err.code = body.query && typeof body.query === "string" && body.query.length > MAX_BODY_QUERY_CHARS
      ? "REQUEST_TOO_LARGE"
      : "INVALID_REQUEST";
    throw err;
  }
  return { query: body.query };
}

function router() {
  const r = express.Router();

  r.post("/agent/search", requireAuth({ managedOnly: true }), async (req, res) => {
    let query;
    try {
      query = validateSearchBody(req.body).query;
    } catch (err) {
      const code = err && err.code === "REQUEST_TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST";
      return res.status(statusFor(code)).json(errorBody(code));
    }
    const ctx = req.subi || {};
    let uidHash = "unknown";
    try {
      const crypto = require("crypto");
      uidHash = crypto.createHash("sha256").update(String(ctx.uid || ""), "utf8").digest("hex").slice(0, 16);
    } catch (_) {
      // Hash failure still rate-limits under a shared bucket (fail closed).
    }
    if (rateLimited(uidHash)) {
      try {
        logWarn("managed-search-rate-limited", {});
      } catch (_) { /* observability never affects the denial */ }
      return res.status(statusFor("TOO_MANY_ACTIVE_REQUESTS")).json(errorBody("TOO_MANY_ACTIVE_REQUESTS"));
    }
    try {
      const config = await agentConfig.getManagedAgentConfig();
      const gate = agentConfig.evaluateAgentAvailability(config, ctx.uid);
      if (!gate.allowed) {
        return res.status(statusFor("MANAGED_AGENT_DISABLED")).json(errorBody("MANAGED_AGENT_DISABLED"));
      }
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
    }
    try {
      const access = await accessService.resolveSubiAccess({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        accountType: ctx.accountType,
      });
      if (!access.allowed) {
        return res.status(statusFor("SUBI_ACCESS_DISABLED")).json(errorBody("SUBI_ACCESS_DISABLED"));
      }
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
    }
    try {
      const { results, provider } = await webSearch.searchWeb(query);
      try {
        logInfo("managed-search", { resultCount: results.length, provider: provider === "keyed" ? "keyed" : "keyless" });
      } catch (_) { /* never affects the response */ }
      return res.status(200).json({ results });
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
      const safe = safeCode(code) !== "INTERNAL" ? code : "INTERNAL";
      const terminal = new Set(["INVALID_REQUEST", "REQUEST_TOO_LARGE", "PROVIDER_AUTH_FAILED", "PROVIDER_RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "WEB_SEARCH_UNAVAILABLE", "SUBI_ACCESS_UNAVAILABLE"]);
      const out = terminal.has(safe) ? safe : "INTERNAL";
      try {
        logWarn("managed-search-failed", { code: safeCode(out) });
      } catch (_) { /* never affects the response */ }
      return res.status(statusFor(out)).json(errorBody(out));
    }
  });

  return r;
}

module.exports = { managedSearchRouter: router, clearRateForTests };
