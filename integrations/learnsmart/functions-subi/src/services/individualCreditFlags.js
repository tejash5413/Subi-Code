// functions-subi/src/services/individualCreditFlags.js
// Phase 1 foundation (NO behavior change — defaults ALL OFF).
// Rollout gates for individual credit system. School token quota MUST NOT
// depend on these flags.
//
// Stored (subi DB): systemConfig/individualCreditFlags
//   { shadowEnabled, shadowTestUids, enforcementEnabled, billingEnabled,
//     topupsEnabled, fullAgentCapabilitiesEnabled, autoModelDiscoveryEnabled,
//     updatedAt, updatedBy }
//
// Shadow targeting (FAIL CLOSED): shadowEnabled=true shadows ONLY the UIDs
// explicitly listed in shadowTestUids. An EMPTY list shadows NOBODY — there
// is no implicit global rollout from an empty allowlist. Controlled rollout
// shape: shadowEnabled=true + shadowTestUids=[...test UIDs]. A future global
// rollout would need a separate explicit flag (not added here). The doc is
// absent by default, so all flags (including shadow) stay OFF until a
// Superadmin explicitly writes them.
//
// BOUNDARY: uses ONLY subiDb. DI supports fakes.

const { subiDb } = require("../db");

const COLLECTION = "systemConfig";
const DOC = "individualCreditFlags";

const MAX_SHADOW_TEST_UIDS = 10;
const MAX_UID_LEN = 128;

const DEFAULTS = Object.freeze({
  shadowEnabled: false,
  shadowTestUids: Object.freeze([]),
  enforcementEnabled: false,
  billingEnabled: false,
  topupsEnabled: false,
  fullAgentCapabilitiesEnabled: false,
  autoModelDiscoveryEnabled: false,
});

function defaultDeps() {
  return { store: subiDb };
}

function normalizeShadowTestUids(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const uid = raw.trim().slice(0, MAX_UID_LEN);
    if (!uid || seen.has(uid)) continue;
    // No wildcards: "*" / "all" (any case) are rejected, never stored.
    // There is no implicit global mode; a global rollout would need its own
    // explicit flag designed separately.
    if (uid === "*" || uid.toLowerCase() === "all") continue;
    seen.add(uid);
    if (seen.size > MAX_SHADOW_TEST_UIDS) break;
    out.push(uid);
  }
  return out;
}

function toSafeFlags(data) {
  const src = (data && typeof data === "object") ? data : {};
  return {
    commerceVersion: Number.isSafeInteger(src.commerceVersion) && src.commerceVersion > 0 ? src.commerceVersion : 1,
    shadowEnabled: src.shadowEnabled === true,
    shadowTestUids: normalizeShadowTestUids(src.shadowTestUids),
    enforcementEnabled: src.enforcementEnabled === true,
    billingEnabled: src.billingEnabled === true,
    topupsEnabled: src.topupsEnabled === true,
    fullAgentCapabilitiesEnabled: src.fullAgentCapabilitiesEnabled === true,
    autoModelDiscoveryEnabled: src.autoModelDiscoveryEnabled === true,
    updatedAt: src.updatedAt || null,
    updatedBy: typeof src.updatedBy === "string" ? src.updatedBy : null,
  };
}

// Scoped shadow gate (FAIL CLOSED): false unless the shadow switch is ON
// and the UID is explicitly listed in a NON-EMPTY test-UID allowlist. An
// empty/missing list shadows nobody — there is no implicit global rollout.
function isShadowEnabledForUid(flags, uid) {
  if (!flags || flags.shadowEnabled !== true) return false;
  const list = Array.isArray(flags.shadowTestUids) ? flags.shadowTestUids : [];
  if (list.length === 0) return false;
  const id = String(uid || "").trim().slice(0, MAX_UID_LEN);
  return id !== "" && list.includes(id);
}

async function getIndividualCreditFlags(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const snap = await store.collection(COLLECTION).doc(DOC).get();
  return toSafeFlags(snap.exists ? snap.data() : DEFAULTS);
}

// Only commercial sales switches. This API cannot enable enforcement,
// agent capabilities or shadow rollout as a side effect of saving prices.
async function setCommerceAvailability({ billingEnabled, topupsEnabled, expectedFlagVersion, adminUid }, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const invalid = () => Object.assign(new Error('availability changed or invalid; refresh'), { code: 'INVALID_REQUEST' });
  if (typeof billingEnabled !== 'boolean' || typeof topupsEnabled !== 'boolean' || !Number.isSafeInteger(expectedFlagVersion)) throw invalid();
  const ref = store.collection(COLLECTION).doc(DOC);
  return store.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = toSafeFlags(snapshot.exists ? snapshot.data() : DEFAULTS);
    if (current.commerceVersion !== expectedFlagVersion) throw invalid();
    const patch = { billingEnabled, topupsEnabled, commerceVersion: current.commerceVersion + 1, updatedAt: new Date(), updatedBy: String(adminUid || '').slice(0, 128) };
    tx.set(ref, patch, { merge: true });
    return { ...current, ...patch };
  });
}

module.exports = {
  DEFAULTS,
  getIndividualCreditFlags,
  setCommerceAvailability,
  normalizeShadowTestUids,
  isShadowEnabledForUid,
  MAX_SHADOW_TEST_UIDS,
  COLLECTION,
  DOC,
};
