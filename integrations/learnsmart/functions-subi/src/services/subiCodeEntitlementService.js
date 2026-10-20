// functions-subi/src/services/subiCodeEntitlementService.js
// Subi Code purchase + expiry entitlement for the managed runtime.
// Single-plan individual product: there is ONE individual SUBI subscription.
// No Basic/Plus/Pro. No commercial tier requirement.
//
// RULE (authoritative):
// - school accounts: EXPIRY ONLY (Subi Code is included by default).
//   Blocked only when the school subscription is positively expired.
// - individual accounts: active SUBI entitlement AND plan not expired.
//   Active = new-style `subscription.subiCode` enabled (preferred) OR legacy
//   `subiCodeTier` present (compatibility fallback; carries no plan meaning).
//   Missing entitlement fails closed (SUBI_CODE_REQUIRED); past renewalDate
//   fails closed (SUBI_PLAN_EXPIRED).
//
// Compatibility precedence for individuals:
//   explicit new subiCode entitlement -> preferred (source individual_subi)
//   legacy valid subiCodeTier + renewal -> fallback (source legacy_tier_compat)
//   neither                            -> SUBI_CODE_REQUIRED
//
// BOUNDARY: pure evaluation here; callers fetch trusted snapshots via
// learnsmartDirectoryService (LearnSmart `(default)` DB, read-only).
// Never writes. Never secrets / providers.

function isExpiredMs(renewalDateMs) {
  return (
    typeof renewalDateMs === "number" &&
    Number.isFinite(renewalDateMs) &&
    renewalDateMs > 0 &&
    renewalDateMs < Date.now()
  );
}

// Normalized single-plan evaluation of an individual subscription snapshot.
// Returns { active, source } where source is one of:
//   individual_subi | legacy_tier_compat | none
function evaluateIndividualSubi({ userSubscription } = {}) {
  const sub = userSubscription && typeof userSubscription === "object" ? userSubscription : null;
  if (!sub) return { active: false, source: "none" };
  if (sub.subiCodeActive === false) return { active: false, source: "none" };
  if (sub.subiCodeActive === true) return { active: true, source: "individual_subi" };
  // Legacy compatibility: a stored tier still implies an existing SUBI
  // subscription. The tier VALUE is never inspected (no plan gating).
  const tier = typeof sub.subiCodeTier === "string" ? sub.subiCodeTier.trim() : "";
  if (tier) return { active: true, source: "legacy_tier_compat" };
  return { active: false, source: "none" };
}

// Authoritative paid-through horizon for individual SUBI coverage.
// The subscription may carry up to three instants (periodEndMs,
// paidThroughMs, renewalDateMs) that can diverge across renewals/webhooks.
// The effective coverage is the LATEST valid instant: a user paid through
// Nov 30 must not be marked expired on Nov 6 because periodEndMs lagged.
// Returns the max finite >0 number, or null when no usable instant exists.
function resolvePaidThroughMs(sub) {
  const src = sub && typeof sub === "object" ? sub : {};
  const cands = [src.periodEndMs, src.paidThroughMs, src.renewalDateMs].filter(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0
  );
  if (cands.length === 0) return null;
  return Math.max.apply(null, cands);
}

// Inputs are trusted snapshots (or null when missing).
// userSubscription: { renewalDateMs, periodEndMs, paidThroughMs,
//   subiCodeActive, subiCodeTier } | null
// schoolSubscription: { renewalDateMs } | null
// Returns { allowed, code?, source?, renewalDateMs? } — codes stay
// server-clean and bounded. No tier is ever returned (no commercial plans).
function evaluateSubiCodeEntitlement({ accountType, userSubscription, schoolSubscription }) {
  const kind = String(accountType || "").trim().toLowerCase();
  if (kind !== 'school' && kind !== 'individual') {
    return { allowed: false, code: 'ACCOUNT_TYPE_UNSUPPORTED', source: 'none', renewalDateMs: null };
  }

  if (kind === "school") {
    // Expiry only. Fail open when the school carries no subscription data
    // (server cannot prove expiry); the base access policy still applies.
    const renewalMs = userSubscription && typeof userSubscription.renewalDateMs === "number"
      ? userSubscription.renewalDateMs
      : schoolSubscription && typeof schoolSubscription.renewalDateMs === "number"
        ? schoolSubscription.renewalDateMs
        : null;
    if (isExpiredMs(renewalMs)) {
      return { allowed: false, code: "SUBI_PLAN_EXPIRED", source: "school_default", renewalDateMs: renewalMs };
    }
    return { allowed: true, source: "school_default", renewalDateMs: renewalMs };
  }

  // Individual single-plan: active SUBI + unexpired.
  const { active, source } = evaluateIndividualSubi({ userSubscription });
  if (!active) {
    return { allowed: false, code: "SUBI_CODE_REQUIRED", source: "none", renewalDateMs: null };
  }
  // Horizon is the latest paid-through instant across all stored fields
  // (periodEndMs/paidThroughMs/renewalDateMs may diverge across renewals).
  const renewalMs = resolvePaidThroughMs(userSubscription);
  if (isExpiredMs(renewalMs)) {
    return { allowed: false, code: "SUBI_PLAN_EXPIRED", source, renewalDateMs: renewalMs };
  }
  return { allowed: true, source, renewalDateMs: renewalMs };
}

module.exports = {
  evaluateSubiCodeEntitlement,
  evaluateIndividualSubi,
  resolvePaidThroughMs,
};
