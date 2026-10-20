// One managed OpenRouter free pool across all schools, individuals and models.
// This is local admission control, not a replacement for provider limits.
// No API keys, identities, prompts or responses enter this document.
const { subiDb } = require('../db');
const REF = ['managedProviderCapacity', 'openrouter-free'];
const WINDOW_MS = 60000, MAX_PER_WINDOW = 20, MAX_CONCURRENT = 2, LEASE_MS = 550000;
const error = (code, delay) => Object.assign(new Error('managed free capacity unavailable'), {
  code, providerAccepted: false, ...(delay === undefined ? {} : { httpStatus: 429, retryAfterMs: delay }),
});
const clock = d => Number.isSafeInteger(d.nowMs) ? d.nowMs : Date.now();
const reference = store => store.collection(REF[0]).doc(REF[1]);
function cleanState(raw, now) {
  const value = raw || {};
  const leases = {};
  for (const [key, end] of Object.entries(value.leases || {}).slice(0, 20)) {
    if (/^[A-Za-z0-9_-]{1,128}$/.test(key) && Number.isSafeInteger(end) && end > now && end <= now + LEASE_MS) leases[key] = end;
  }
  const windowStartMs = Number.isSafeInteger(value.windowStartMs) && value.windowStartMs <= now && now < value.windowStartMs + WINDOW_MS ? value.windowStartMs : now;
  return { leases, windowStartMs, requestCount: windowStartMs === value.windowStartMs && Number.isSafeInteger(value.requestCount) ? Math.max(0, Math.min(MAX_PER_WINDOW, value.requestCount)) : 0,
    cooldownUntilMs: Number.isSafeInteger(value.cooldownUntilMs) ? value.cooldownUntilMs : 0 };
}
async function acquireFreeCapacity({ upstreamModelId, attemptId }, deps = {}) {
  if (typeof upstreamModelId !== 'string' || !upstreamModelId.endsWith(':free')) return null;
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) throw error('INVALID_REQUEST');
  const store = deps.store || subiDb, now = clock(deps), ref = reference(store);
  return store.runTransaction(async tx => {
    const snap = await tx.get(ref), state = cleanState(snap.exists ? snap.data() : null, now);
    if (state.cooldownUntilMs > now) throw error('PROVIDER_RATE_LIMITED', state.cooldownUntilMs - now);
    if (state.leases[attemptId]) return { attemptId };
    if (Object.keys(state.leases).length >= MAX_CONCURRENT) throw error('PROVIDER_RATE_LIMITED', 5000);
    if (state.requestCount >= MAX_PER_WINDOW) throw error('PROVIDER_RATE_LIMITED', state.windowStartMs + WINDOW_MS - now);
    state.leases[attemptId] = now + LEASE_MS; state.requestCount += 1;
    tx.set(ref, { ...state, updatedAtMs: now });
    return { attemptId };
  });
}
async function releaseFreeCapacity(lease, deps = {}) {
  if (!lease?.attemptId) return;
  const store = deps.store || subiDb, now = clock(deps), ref = reference(store);
  await store.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const state = cleanState(snap.data(), now);
    delete state.leases[lease.attemptId];
    tx.set(ref, { ...state, updatedAtMs: now });
  });
}
async function recordFreeCapacityReset({ retryAtMs }, deps = {}) {
  const store = deps.store || subiDb, now = clock(deps), ref = reference(store);
  if (!Number.isSafeInteger(retryAtMs) || retryAtMs <= now || retryAtMs > now + 86400000) throw error('INVALID_REQUEST');
  await store.runTransaction(async tx => {
    const snap = await tx.get(ref), state = cleanState(snap.exists ? snap.data() : null, now);
    tx.set(ref, { ...state, cooldownUntilMs: Math.max(state.cooldownUntilMs, retryAtMs), updatedAtMs: now });
  });
}
module.exports = { acquireFreeCapacity, releaseFreeCapacity, recordFreeCapacityReset };
