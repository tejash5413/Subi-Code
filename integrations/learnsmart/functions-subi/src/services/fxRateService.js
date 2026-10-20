// functions-subi/src/services/fxRateService.js
// Phase 1 foundation (NO behavior change — not called by routes yet).
// Individual-only USD/INR snapshots for monthly grants + top-up quotes.
//
// Collection (subi DB): fxRates/USD_INR
//   { pair:"USD_INR", rate, source, fetchedAtMs, snapshotId, updatedAt, updatedBy }
//
// Rules:
// - rate must be finite 40..200 (sanity; today's ~88-90 + buffer).
// - Grants freeze the cycle's snapshot; live FX moves never mutate balances.
// - Schools never read this service.
//
// BOUNDARY: uses ONLY subiDb (via injected store). Never learnsmartDb.
// DI: methods accept optional deps ({ store }) for fakes.

const { subiDb } = require("../db");

const PAIR = "USD_INR";
const COLLECTION = "fxRates";
const MIN_RATE = 40;
const MAX_RATE = 200;

function defaultDeps() {
  return { store: subiDb };
}

function invalidRequest(message) {
  const err = new Error(message || "invalid fx payload");
  err.code = "INVALID_REQUEST";
  return err;
}

function cleanRate(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < MIN_RATE || n > MAX_RATE) {
    throw invalidRequest(`fx rate must be finite ${MIN_RATE}..${MAX_RATE}`);
  }
  return n;
}

function toSafeFx(docId, data) {
  if (!data || typeof data !== "object") return null;
  const rate = data.rate;
  if (docId !== PAIR || data.pair !== PAIR || typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE
    || typeof data.source !== 'string' || !data.source.trim() || data.source.length > 64
    || !Number.isSafeInteger(data.fetchedAtMs) || data.fetchedAtMs <= 0
    || typeof data.snapshotId !== 'string' || !data.snapshotId.trim() || data.snapshotId.length > 64) return null;
  return {
    pair: PAIR,
    rate,
    source: typeof data.source === "string" ? data.source.slice(0, 64) : null,
    fetchedAtMs: typeof data.fetchedAtMs === "number" ? data.fetchedAtMs : null,
    snapshotId: typeof data.snapshotId === "string" ? data.snapshotId.slice(0, 64) : null,
    updatedAt: data.updatedAt || null,
  };
}

async function getFxRate(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const snap = await store.collection(COLLECTION).doc(PAIR).get();
  if (!snap.exists) return null;
  return toSafeFx(PAIR, snap.data() || {});
}

async function setFxRate({ rate, source, adminUid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const clean = cleanRate(rate);
  const provenance = source === undefined || source === null || source === '' ? 'manual' : source;
  if (typeof provenance !== 'string' || !provenance.trim() || provenance.trim().length > 64) {
    throw invalidRequest('source must be a bounded non-empty string');
  }
  const now = new Date();
  const nowMs = Date.now();
  const ref = d.store.collection(COLLECTION).doc(PAIR);
  const snapshotId = `${PAIR}-${nowMs}-${String(clean).replace(".", "p")}`;
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        pair: PAIR,
        rate: clean,
        source: provenance.trim(),
        fetchedAtMs: nowMs,
        snapshotId,
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      },
      { merge: true }
    );
  });
  return { pair: PAIR, rate: clean, snapshotId, fetchedAtMs: nowMs };
}

module.exports = { PAIR, MIN_RATE, MAX_RATE, getFxRate, setFxRate };
