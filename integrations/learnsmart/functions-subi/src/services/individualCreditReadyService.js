// functions-subi/src/services/individualCreditReadyService.js
// Shared lazy credit-cycle preflight (individual ONLY).
// Single entry point for /managed/usage, /managed/limits, and POST
// /agent/turn: resolve account -> verify active SUBI entitlement -> ensure
// the CURRENT monthly paid sub-period -> return the live credit account.
// Schools NEVER enter this module (fail closed before any store access).
//
// Period math lives ONLY in subiBillingPeriodService.resolveCurrentCycleBounds
// (monthly sub-periods inside paid-through coverage; no whole-period monster
// cycles, no advance grants, no historical stacking). Grant math lives ONLY in
// individualCreditCycleService.ensureCurrentCreditCycle (deterministic IDs,
// 80% fresh-only rollover, top-up preservation, FX fail-closed). This module
// routes between them and never reimplements either.
//
// BOUNDARY: directory reads ONLY via learnsmartDirectoryService (no direct
// store string for the directory DB here); credit writes ONLY via the cycle
// engine on subiDb (injected store). Never Cashfree, never secrets.

const { subiDb } = require("../db");
const { getUserProfile } = require("./learnsmartDirectoryService");
const { evaluateSubiCodeEntitlement, resolvePaidThroughMs } = require("./subiCodeEntitlementService");
const { resolvePaidCreditCycle } = require('./subiPaidCreditPeriodService');
const { ensureCurrentCreditCycle } = require("./individualCreditCycleService");
const { info: logInfo, warn: logWarn, hashRequestId } = require("../utils/structuredLogger");

function defaultDeps() {
  return { store: subiDb };
}
function cleanId(v, max = 128) { return String(v || "").trim().slice(0, max); }
function invalidRequest(m) { const e = new Error(m || "invalid credit ready payload"); e.code = "INVALID_REQUEST"; return e; }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }
function numOrNull(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}
function emit(action, uid, extra) {
  try {
    const fields = { uidHash: hashRequestId(uid) };
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
          if (k === 'cycleId' && typeof v === 'string') fields.cycleIdHash = hashRequestId(v);
          else fields[k] = v;
        }
      }
    }
    (action === "credit_cycle.expired" || action === "credit_cycle.fx_unavailable" ? logWarn : logInfo)(action, fields);
  } catch (_) {
    // Observability must never affect the preflight.
  }
}

// Lazy ensure for one individual uid. Throws controlled codes only:
//   ACCOUNT_TYPE_UNSUPPORTED (school/unknown — never creates credit docs)
//   SUBI_UNKNOWN_USER / SUBI_CODE_REQUIRED / SUBI_PLAN_EXPIRED
//   SUBI_NO_PAID_PERIOD (no usable billing anchor; legacy compat)
//   FX_UNAVAILABLE (new cycle due but economics unresolvable; old cycle untouched)
//   INVALID_REQUEST (future-paid period)
// Options (DI for tests): { store, getProfile(uid)->profile, nowMs }.
async function ensureIndividualCreditReady({ uid, accountType } = {}, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const claimed = String(accountType || "").trim().toLowerCase();
  if (claimed === "school") throw coded("credit cycles are individual-only", "ACCOUNT_TYPE_UNSUPPORTED");
  if (claimed !== "" && claimed !== "individual") throw coded("unsupported account type", "ACCOUNT_TYPE_UNSUPPORTED");
  const nowMs = typeof d.nowMs === "number" && Number.isFinite(d.nowMs) ? Math.floor(d.nowMs) : Date.now();
  emit("credit_cycle.ensure_started", id, null);
  const profile = typeof d.getProfile === "function"
    ? await d.getProfile(id)
    : await getUserProfile(id);
  if (!profile) throw coded("unknown user", "SUBI_UNKNOWN_USER");
  if (profile.accountType !== "individual") {
    throw coded("credit cycles are individual-only", "ACCOUNT_TYPE_UNSUPPORTED");
  }
  const entitlement = evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: profile.subscription && typeof profile.subscription === "object" ? profile.subscription : null,
    schoolSubscription: null,
  });
  if (!entitlement.allowed) {
    emit("credit_cycle.expired", id, { code: entitlement.code || "SUBI_CODE_REQUIRED" });
    throw coded(entitlement.code === "SUBI_PLAN_EXPIRED" ? "subscription expired" : "subi code required",
      entitlement.code || "SUBI_CODE_REQUIRED");
  }
  const sub = profile.subscription && typeof profile.subscription === "object" ? profile.subscription : {};
  const start = numOrNull(sub.periodStartMs);
  // Authoritative horizon: latest paid-through instant across periodEndMs /
  // paidThroughMs / renewalDateMs. A ?? chain takes the FIRST present field
  // and can mark a user expired early (e.g. stale periodEndMs Nov 6 while
  // paidThroughMs covers Nov 30). resolveCurrentCycleBounds below still
  // returns one monthly sub-period at a time (truncated final period).
  const paidThrough = resolvePaidThroughMs(sub);
  // A stored wallet is not evidence of a current paid sub-period. Routes may
  // display its snapshot on failure, but readiness never grants or authorizes
  // spending an old wallet without a valid billing anchor.
  if (start === null || start <= 0 || paidThrough === null || paidThrough <= start) {
    throw coded("no usable subi paid period", "SUBI_NO_PAID_PERIOD");
  }
  if (nowMs >= paidThrough) {
    emit("credit_cycle.expired", id, { code: "SUBI_PLAN_EXPIRED" });
    throw coded("subscription period ended", "SUBI_PLAN_EXPIRED");
  }
  let bounds;
  try {
    bounds = await resolvePaidCreditCycle({ uid: id, periodStartMs: start, paidThroughMs: paidThrough, nowMs }, d);
  } catch (err) {
    if (err && err.code === "SUBI_PLAN_EXPIRED") emit("credit_cycle.expired", id, { code: "SUBI_PLAN_EXPIRED" });
    throw err;
  }
  let out;
  try {
    out = await ensureCurrentCreditCycle({
      uid: id,
      accountType: "individual",
      userSubscription: { subiCodeActive: true, renewalDateMs: paidThrough },
      paidPeriodStartMs: bounds.paidPeriodStartMs,
      paidPeriodEndMs: bounds.paidPeriodEndMs,
      economics: bounds.economics,
      nowMs,
    }, { store: d.store });
  } catch (err) {
    if (err && err.code === "FX_UNAVAILABLE") emit("credit_cycle.fx_unavailable", id, null);
    else if (err && err.code === "SUBI_PLAN_EXPIRED") emit("credit_cycle.expired", id, { code: "SUBI_PLAN_EXPIRED" });
    throw err;
  }
  if (out && out.alreadyGranted === true) {
    emit("credit_cycle.already_current", id, { cycleId: String(out.cycleId || "").slice(0, 160) });
  } else if (out && out.cycleAdvanced === true) {
    emit("credit_cycle.recovered", id, {
      cycleId: String(out.cycleId || "").slice(0, 160),
      gap: out.gapFromPrevious === true,
    });
  } else {
    emit("credit_cycle.created", id, { cycleId: String((out && out.cycleId) || "").slice(0, 160) });
  }
  return out;
}

module.exports = { ensureIndividualCreditReady };
