// functions-subi/src/services/individualCreditCycleService.js
// Individual ONLY credit-cycle + 80% rollover engine (cycle phase).
// Schools NEVER enter this module (no YYYY-MM, no token logic here).
//
// CYCLE RULES (authoritative):
// - Cycles map 1:1 to the paid SUBI period supplied by the caller (later:
//   Cashfree webhook). The ONLY period source is resolveCreditCyclePeriod;
//   there is NO `Date.now() + 30 days` anywhere in this module.
// - cycleId is deterministic: `${uid}:${paidPeriodStartMs}:${paidPeriodEndMs}`.
//   Same paid period ALWAYS yields the same cycleId (grant identity for
//   idempotency). No Date.now()/random UUID in the identity path.
// - First cycle: full monthly grant from frozen FX/economics, no rollover.
// - Same cycle re-entry: return the existing account WITHOUT granting again.
// - Advance (new paid period): 80% (configured rolloverPct) of unused FRESH
//   monthly milli only. Prior rollover is REPLACED (never re-rolled). Top-up
//   carries 100%. In-flight holds from the expired cycle are settled first:
//   reserved-state holds release back (they were never spent, so they count
//   as fresh); dispatched/started holds are forfeited (provider-risk money).
// - FX + economics snapshots freeze onto the account at grant time; later
//   config moves never mutate granted balances.
// - Ledger IDs are deterministic (`grant-${cycleId}`, `rollover-${cycleId}`)
//   so retried advances converge instead of duplicating.
//
// BOUNDARY: uses ONLY subiDb (creditAccounts, fxRates, systemConfig). Never
// learnsmartDb (entitlement arrives as a caller-supplied trusted snapshot).
// Never Cashfree (not wired yet). DI supports fakes.

const { subiDb } = require("../db");
const { FieldValue } = require("firebase-admin/firestore");
const {
  toSafeAccount,
  emptyAccount,
  COLLECTION,
  LEDGER,
} = require("./individualCreditAccountService");
const { getFxRate } = require("./fxRateService");
const {
  getEconomicsConfig,
  DEFAULTS: ECON_DEFAULTS,
} = require("./individualCreditEconomicsConfig");
const { monthlyGrantCredits } = require("./individualCreditEconomics");
const {
  evaluateSubiCodeEntitlement,
} = require("./subiCodeEntitlementService");

function defaultDeps() {
  return { store: subiDb };
}
function cleanId(v, max = 200) { return String(v || "").trim().slice(0, max); }
function invalidRequest(m) { const e = new Error(m || "invalid credit cycle payload"); e.code = "INVALID_REQUEST"; return e; }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }
function num(v) { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0; }

// ---------- Authoritative cycle-period resolver (single period source) ----------
// Input must be the authoritative paid SUBI period (caller/test supplied for
// now; Cashfree webhook later). Rejects anything else — never invents dates.
function resolveCreditCyclePeriod({ paidPeriodStartMs, paidPeriodEndMs } = {}) {
  const start = Number(paidPeriodStartMs);
  const end = Number(paidPeriodEndMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) {
    throw invalidRequest("paid period must satisfy start > 0 and end > start");
  }
  if (!Number.isSafeInteger(Math.floor(start)) || !Number.isSafeInteger(Math.floor(end))) {
    throw invalidRequest("paid period bounds must be safe integers");
  }
  return { cycleStartedAtMs: Math.floor(start), cycleEndsAtMs: Math.floor(end) };
}

// Deterministic grant identity: same uid + same paid period => same cycleId.
function creditCycleIdFor(uid, cycleStartedAtMs, cycleEndsAtMs) {
  const id = cleanId(uid, 128);
  if (!id) throw invalidRequest("missing uid for cycle id");
  const { cycleStartedAtMs: s, cycleEndsAtMs: e } = resolveCreditCyclePeriod({
    paidPeriodStartMs: cycleStartedAtMs, paidPeriodEndMs: cycleEndsAtMs,
  });
  return `${id}:${s}:${e}`;
}

function normalizeFxRate(fxRate) {
  if (fxRate && typeof fxRate === "object" && (typeof fxRate.rate === "number" || typeof fxRate.rate === "string")) {
    const rate = Number(fxRate.rate);
    if (!Number.isFinite(rate) || rate < 40 || rate > 200) throw invalidRequest("fxRate must be finite 40..200");
    return {
      pair: "USD_INR",
      rate,
      source: typeof fxRate.source === "string" ? fxRate.source.slice(0, 64) : "injected",
      fetchedAtMs: typeof fxRate.fetchedAtMs === "number" ? fxRate.fetchedAtMs : null,
      snapshotId: typeof fxRate.snapshotId === "string" ? fxRate.snapshotId.slice(0, 64) : null,
    };
  }
  const rate = Number(fxRate);
  if (!Number.isFinite(rate) || rate < 40 || rate > 200) throw invalidRequest("fxRate must be finite 40..200");
  return { pair: "USD_INR", rate, source: "injected", fetchedAtMs: null, snapshotId: null };
}

function normalizeEconomics(economics) {
  // Same defaults + bounds as individualCreditEconomicsConfig (which does not
  // export its sanitizer): fill missing keys from DEFAULTS, then validate.
  const src = (economics && typeof economics === "object") ? economics : {};
  const pick = (key) => (Number.isFinite(Number(src[key])) ? Number(src[key]) : ECON_DEFAULTS[key]);
  const cfg = {
    priceINR: Math.floor(pick("priceINR")),
    bufferINR: Math.floor(pick("bufferINR")),
    providerFundingMultiplier: pick("providerFundingMultiplier"),
    rolloverPct: pick("rolloverPct"),
    topupMarginPct: pick("topupMarginPct"),
  };
  if (!(cfg.providerFundingMultiplier >= 1 && cfg.providerFundingMultiplier <= 3)) {
    throw invalidRequest("providerFundingMultiplier must be 1..3");
  }
  if (!(cfg.rolloverPct >= 0 && cfg.rolloverPct <= 1)) throw invalidRequest("rolloverPct must be 0..1");
  if (!(cfg.priceINR >= 1 && cfg.priceINR <= 100000)) throw invalidRequest("priceINR out of range");
  if (!(cfg.bufferINR >= 0 && cfg.bufferINR < cfg.priceINR)) throw invalidRequest("bufferINR must be 0..<price");
  return cfg;
}

// An account's cycle is usable only while its paid period has not ended.
// (No calendar-month logic anywhere in this module by design.)
function isCycleActive(acct, nowMs) {
  const end = acct && typeof acct.cycleEndsAtMs === "number" ? acct.cycleEndsAtMs : null;
  return end !== null && nowMs < end;
}

// Settle leftover holds from an expired cycle before advancing. Reserved
// holds were never spent: their breakdown returns to balances (fresh again).
// Dispatched/started holds may have cost the provider: forfeited, no refund.
// Returns { balances:{monthly,rollover,topup}, settledHoldMilli }.
function settleExpiredHolds(acct) {
  const balances = {
    monthly: num(acct.monthlyRemainingCreditsMilli),
    rollover: num(acct.rolloverRemainingCreditsMilli),
    topup: num(acct.topupRemainingCreditsMilli),
  };
  let settledHoldMilli = 0;
  const active = acct.activeReservations && typeof acct.activeReservations === "object" ? acct.activeReservations : {};
  for (const entry of Object.values(active)) {
    const e = (entry && typeof entry === "object") ? entry : {};
    const amount = num(e.amountMilli);
    if (amount <= 0) continue;
    settledHoldMilli += amount;
    const state = typeof e.state === "string" ? e.state : "reserved";
    if (state === "dispatched" || state === "started") continue; // forfeit
    const b = e.breakdown && typeof e.breakdown === "object" ? e.breakdown : null;
    if (b) {
      balances.rollover += num(b.rolloverMilli);
      balances.monthly += num(b.monthlyMilli);
      balances.topup += num(b.topupMilli);
    } else {
      balances.monthly += amount; // legacy hold without breakdown
    }
  }
  return { balances, settledHoldMilli };
}

// Authoritative per-cycle grant entry point (tests/manual calls invoke it;
// Cashfree webhook will invoke it later). Transaction-safe + idempotent.
async function ensureCurrentCreditCycle(
  {
    uid,
    accountType,
    userSubscription,
    paidPeriodStartMs,
    paidPeriodEndMs,
    fxRate,
    economics,
    nowMs: nowMsOverride,
  } = {},
  deps
) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid, 128);
  if (!id) throw invalidRequest("missing uid");
  // Fail closed: only individual accounts may hold credit cycles. The caller
  // must route via quotaModeService; this guard is the second barrier.
  if (String(accountType || "").trim().toLowerCase() !== "individual") {
    throw invalidRequest("credit cycles are individual-only");
  }
  // Individual SUBI entitlement: activated tier + unexpired plan.
  const entitlement = evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: userSubscription && typeof userSubscription === "object" ? userSubscription : null,
    schoolSubscription: null,
  });
  if (!entitlement.allowed) {
    throw coded(entitlement.code === "SUBI_PLAN_EXPIRED" ? "subscription expired" : "subi code required",
      entitlement.code || "SUBI_CODE_REQUIRED");
  }
  const { cycleStartedAtMs, cycleEndsAtMs } = resolveCreditCyclePeriod({ paidPeriodStartMs, paidPeriodEndMs });
  // nowMs override exists for time-travel tests (boundary crossings). Production
  // callers omit it (real clock). Entitlement above still uses the real clock
  // via evaluateSubiCodeEntitlement; lazy callers pass a paidThrough that is
  // future on both clocks for active subscriptions.
  const nowMs = Number.isFinite(Number(nowMsOverride)) ? Math.floor(Number(nowMsOverride))
    : (deps && Number.isFinite(Number(deps.nowMs)) ? Math.floor(Number(deps.nowMs)) : Date.now());
  if (nowMs < cycleStartedAtMs) throw invalidRequest("paid period has not started");
  if (nowMs >= cycleEndsAtMs) throw coded("subscription period ended", "SUBI_PLAN_EXPIRED");
  const cid = creditCycleIdFor(id, cycleStartedAtMs, cycleEndsAtMs);

  // Same-cycle fast path (FX-free): usage refreshes and repeated turns must
  // not require FX when the live cycle already matches. New-cycle grants
  // still resolve FX below and fail closed (no partial cycle).
  try {
    const pre = await d.store.collection(COLLECTION).doc(id).get();
    if (pre && pre.exists) {
      const curPre = toSafeAccount(id, (pre.data && pre.data()) || (typeof pre.data === "function" ? pre.data() : {}));
      if (curPre && curPre.cycleId === cid) {
        return { ...curPre, alreadyGranted: true, cycleAdvanced: false };
      }
    }
  } catch (_) {
    // Fall through to the authoritative transaction path.
  }

  // Resolve frozen inputs OUTSIDE the transaction (reads only; the grant
  // itself stays atomic inside). Injected values let tests freeze time.
  let fxSnap;
  if (fxRate !== undefined && fxRate !== null) {
    fxSnap = normalizeFxRate(fxRate);
  } else {
    const stored = await getFxRate({ store: d.store }).catch(() => null);
    if (!stored || !Number.isFinite(Number(stored.rate))) throw coded("fx rate unavailable", "FX_UNAVAILABLE");
    fxSnap = normalizeFxRate(stored);
  }
  let cfg;
  try {
    cfg = economics !== undefined && economics !== null
      ? normalizeEconomics(economics)
      : normalizeEconomics(await getEconomicsConfig({ store: d.store }));
  } catch (_) { throw coded('economics unavailable', 'SUBI_BILLING_UNAVAILABLE'); }
  const grant = monthlyGrantCredits({
    fxRate: fxSnap.rate,
    priceINR: cfg.priceINR,
    bufferINR: cfg.bufferINR,
    providerFundingMultiplier: cfg.providerFundingMultiplier,
  });
  const grantMilli = num(grant.monthlyGrant) * 1000;
  if (!Number.isSafeInteger(grantMilli) || grantMilli <= 0) throw invalidRequest("grant out of range");
  const economicsSnapshot = {
    priceINR: cfg.priceINR,
    bufferINR: cfg.bufferINR,
    providerFundingMultiplier: cfg.providerFundingMultiplier,
    rolloverPct: cfg.rolloverPct,
    grantCredits: grant.monthlyGrant,
    computedAtMs: nowMs,
  };

  const ref = d.store.collection(COLLECTION).doc(id);
  return d.store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? toSafeAccount(id, snap.data() || {}) : emptyAccount(id, null);
    // Same paid period: return the live cycle WITHOUT granting again.
    if (cur.cycleId === cid) {
      return { ...cur, alreadyGranted: true, cycleAdvanced: false };
    }
    const isFirstCycle = !cur.cycleId;
    // Read reservation ledger truth before any writes. A request may have
    // progressed after its active-index snapshot; terminal reservations must
    // never be refunded twice when the cycle advances.
    const holds = {};
    const holdPatches = [];
    for (const [holdId, entry] of Object.entries(cur.activeReservations || {})) {
      const holdRef = ref.collection(LEDGER).doc(holdId);
      const holdSnap = await tx.get(holdRef);
      const doc = holdSnap.exists ? holdSnap.data() || {} : {};
      if (doc.committed === true || doc.released === true
        || ["committed", "released", "charged"].includes(doc.state)) continue;
      const hold = {
        ...entry,
        state: doc.state || entry.state,
        amountMilli: doc.amountMilli ?? entry.amountMilli,
        breakdown: doc.reservedBreakdown || entry.breakdown,
      };
      holds[holdId] = hold;
      const risk = hold.state === "dispatched" || hold.state === "started";
      holdPatches.push({ ref: holdRef, patch: risk
        ? { state: "charged", chargedMilli: num(hold.amountMilli), chargedAtMs: nowMs, finalReason: "cycle-risk-charged" }
        : { state: "released", released: true, releasedAtMs: nowMs, finalReason: "cycle-reserved-released" } });
    }
    // Settle expired-cycle holds, then roll 80% of unused FRESH monthly only.
    // Adjacency rule (lazy-recovery hardening): rollover applies ONLY when the
    // previous stored cycle is the immediately preceding monthly sub-period
    // (cur.cycleEndsAtMs === new cycleStartedAtMs). Skipped historical months
    // never compound: their monthly + rollover are discarded, top-up still
    // carries 100% (settled.balances.topup includes released top-up holds).
    const settled = settleExpiredHolds({ ...cur, activeReservations: holds });
    const isAdjacentCycle = !isFirstCycle
      && typeof cur.cycleEndsAtMs === "number"
      && cur.cycleEndsAtMs === cycleStartedAtMs;
    const unusedFreshMilli = isAdjacentCycle ? Math.max(0, settled.balances.monthly) : 0;
    const rolloverMilli = isAdjacentCycle ? Math.floor(unusedFreshMilli * cfg.rolloverPct) : 0;
    const next = {
      uid: id,
      cycleId: cid,
      cycleStartedAtMs,
      cycleEndsAtMs,
      monthlyGrantCreditsMilli: grantMilli,
      monthlyRemainingCreditsMilli: grantMilli,
      // Prior rollover expires by replacement (one-cycle validity): only the
      // freshly computed amount survives, never the old remainder.
      rolloverGrantedCreditsMilli: rolloverMilli,
      rolloverRemainingCreditsMilli: rolloverMilli,
      rolloverExpiresAtMs: rolloverMilli > 0 ? cycleEndsAtMs : null,
      // Purchased top-up carries 100% across cycles, untouched by rollover.
      topupRemainingCreditsMilli: settled.balances.topup,
      reservedCreditsMilli: 0,
      activeReservations: {},
      fxSnapshot: fxSnap,
      economicsSnapshot,
      subscriptionActive: true,
      updatedAtMs: nowMs,
    };
    for (const hold of holdPatches) tx.set(hold.ref, hold.patch, { merge: true });
    // Delete the stored map explicitly: recursive merge of {} leaves old
    // keys behind. Safe account projections still expose an empty map.
    tx.set(ref, { ...next, activeReservations: FieldValue.delete() }, { merge: true });
    // Deterministic ledger identities: retries of the same paid period
    // converge on these exact docs instead of duplicating grants.
    tx.set(ref.collection(LEDGER).doc(`grant-${cid}`), {
      type: "subscription_grant", amountMilli: grantMilli, balanceAfterMilli: grantMilli,
      cycleId: cid, reason: "monthly_grant", createdAtMs: nowMs,
      fxSnapshot: fxSnap, economicsSnapshot,
    });
    if (rolloverMilli > 0) {
      tx.set(ref.collection(LEDGER).doc(`rollover-${cid}`), {
        type: "rollover_grant", amountMilli: rolloverMilli, balanceAfterMilli: rolloverMilli,
        cycleId: cid, reason: "rollover_fresh_only", rolloverPct: cfg.rolloverPct,
        freshUnusedMilli: unusedFreshMilli, createdAtMs: nowMs,
      });
    }
    return {
      ...toSafeAccount(id, next),
      alreadyGranted: false,
      cycleAdvanced: !isFirstCycle,
      previousCycleId: isFirstCycle ? null : cur.cycleId,
      settledHoldMilli: settled.settledHoldMilli,
      gapFromPrevious: !isFirstCycle && !isAdjacentCycle,
    };
  });
}

module.exports = {
  resolveCreditCyclePeriod,
  creditCycleIdFor,
  isCycleActive,
  ensureCurrentCreditCycle,
};
