// functions-subi/src/services/individualCreditEconomicsConfig.js
// Superadmin-configurable individual economics. Defaults: price 499, buffer 50.
// Schools never read this. Individuals use snapshot at grant time.
//
// Stored (subi DB): systemConfig/individualCreditEconomics
//   { priceINR, bufferINR, providerFundingMultiplier, rolloverPct, topupMarginPct,
//     updatedAt, updatedBy }

const { subiDb } = require("../db");

const COLLECTION = "systemConfig";
const DOC = "individualCreditEconomics";

const DEFAULTS = Object.freeze({
  priceINR: 499,
  bufferINR: 50,
  providerFundingMultiplier: 1.10,
  rolloverPct: 0.8,
  topupMarginPct: 0.25,
  configVersion: 1,
  topupPacks: Object.freeze([199, 499, 999, 1999].map(packPriceINR => Object.freeze({ packPriceINR, enabled: true }))),
});

function defaultDeps() {
  return { store: subiDb };
}

function invalidRequest(msg) {
  const err = new Error(msg || "invalid economics config");
  err.code = "INVALID_REQUEST";
  return err;
}

function cleanPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 100000) throw invalidRequest("priceINR must be 1..100000");
  return Math.floor(n);
}
function cleanBuffer(v, price) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n >= price) throw invalidRequest("bufferINR must be 0..<price");
  return Math.floor(n);
}
function cleanMultiplier(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 3) throw invalidRequest("providerFundingMultiplier must be 1..3");
  return n;
}
function cleanPct(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw invalidRequest(`${what} must be 0..1`);
  return n;
}

function cleanPacks(packs) {
  if (!Array.isArray(packs) || packs.length > 12) throw invalidRequest('topupPacks must have at most 12 entries');
  const seen = new Set();
  return packs.map(pack => {
    if (!pack || !Number.isSafeInteger(pack.packPriceINR) || pack.packPriceINR < 1 || pack.packPriceINR > 100000 || typeof pack.enabled !== 'boolean' || seen.has(pack.packPriceINR)) throw invalidRequest('invalid or duplicate credit pack');
    seen.add(pack.packPriceINR);
    return { packPriceINR: pack.packPriceINR, enabled: pack.enabled };
  });
}

function toSafeConfig(data) {
  const src = (data && typeof data === "object") ? data : {};
  const price = Number.isFinite(Number(src.priceINR)) ? Math.floor(Number(src.priceINR)) : DEFAULTS.priceINR;
  return {
    configVersion: Number.isSafeInteger(src.configVersion) && src.configVersion > 0 ? src.configVersion : 1,
    topupPacks: cleanPacks(src.topupPacks === undefined ? DEFAULTS.topupPacks : src.topupPacks),
    priceINR: price >= 1 && price <= 100000 ? price : DEFAULTS.priceINR,
    bufferINR:
      Number.isFinite(Number(src.bufferINR)) && Number(src.bufferINR) >= 0 && Number(src.bufferINR) < price
        ? Math.floor(Number(src.bufferINR))
        : DEFAULTS.bufferINR,
    providerFundingMultiplier:
      Number.isFinite(Number(src.providerFundingMultiplier)) ? Number(src.providerFundingMultiplier) : DEFAULTS.providerFundingMultiplier,
    rolloverPct: Number.isFinite(Number(src.rolloverPct)) ? Number(src.rolloverPct) : DEFAULTS.rolloverPct,
    topupMarginPct: Number.isFinite(Number(src.topupMarginPct)) ? Number(src.topupMarginPct) : DEFAULTS.topupMarginPct,
    updatedAt: src.updatedAt || null,
    updatedBy: typeof src.updatedBy === "string" ? src.updatedBy : null,
  };
}

async function getEconomicsConfig(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const snap = await store.collection(COLLECTION).doc(DOC).get();
  return toSafeConfig(snap.exists ? snap.data() : DEFAULTS);
}

async function setEconomicsConfig({ priceINR, bufferINR, providerFundingMultiplier, rolloverPct, topupMarginPct, topupPacks, expectedConfigVersion, adminUid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const price = cleanPrice(priceINR);
  const buffer = cleanBuffer(bufferINR, price);
  const mult = cleanMultiplier(providerFundingMultiplier);
  const roll = cleanPct(rolloverPct, "rolloverPct");
  const top = cleanPct(topupMarginPct, "topupMarginPct");
  if (top === 1) throw invalidRequest('topupMarginPct must be below 1');
  const ref = d.store.collection(COLLECTION).doc(DOC);
  const now = new Date();
  return d.store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = toSafeConfig(snap.exists ? snap.data() : DEFAULTS);
    if (expectedConfigVersion !== undefined && expectedConfigVersion !== current.configVersion) throw invalidRequest('configuration changed; refresh before saving');
    const next = { priceINR: price, bufferINR: buffer, providerFundingMultiplier: mult, rolloverPct: roll, topupMarginPct: top,
      topupPacks: cleanPacks(topupPacks === undefined ? current.topupPacks : topupPacks), configVersion: current.configVersion + 1,
      updatedAt: now, updatedBy: String(adminUid || '').slice(0, 128) };
    tx.set(ref, next, { merge: true });
    return next;
  });
}

module.exports = { DEFAULTS, getEconomicsConfig, setEconomicsConfig, COLLECTION, DOC };
