// Non-monetary admission journal while individual credit enforcement is OFF.
// Never reads token limits or writes token counters / creditAccounts. Replay,
// concurrency and provider-risk state still remain durable and fail closed.
const crypto = require('node:crypto');
const { subiDb } = require('../db');
const MAX_ACTIVE = 2;
const TTL_MS = 10 * 60 * 1000;
function coded(code) { const e = new Error(code); e.code = code; return e; }
function refs(store, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw coded('INVALID_REQUEST');
  return store.collection('individualTurnRequests').doc(id);
}
async function reserveUsage({ uid, requestId, accountType, defaultMaxOutputTokens }, deps = {}) {
  if (accountType !== 'individual') throw coded('ACCOUNT_TYPE_UNSUPPORTED');
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')
    || typeof requestId !== 'string' || !requestId || requestId.length > 64) throw coded('INVALID_REQUEST');
  const store = deps.store || subiDb;
  const id = crypto.createHash('sha256').update(`${uid}:${requestId}`).digest('hex');
  const ref = refs(store, id);
  const owner = store.collection('individualTurnOwners').doc(uid);
  const now = deps.nowMs ?? Date.now();
  await store.runTransaction(async tx => {
    const [prior, index] = await Promise.all([tx.get(ref), tx.get(owner)]);
    if (prior.exists) {
      const p = prior.data() || {};
      throw coded(!p.terminal && p.expiresAtMs > now ? 'REQUEST_IN_PROGRESS' : 'REQUEST_ALREADY_PROCESSED');
    }
    const data = index.exists ? index.data() || {} : {};
    const active = Object.fromEntries(Object.entries(data.active || {}).filter(([, end]) => typeof end === 'number' && end > now));
    if (Object.keys(active).length >= MAX_ACTIVE) throw coded('TOO_MANY_ACTIVE_REQUESTS');
    active[id] = now + TTL_MS;
    tx.set(ref, { uid, ownerId: uid, state: 'reserved', terminal: false, expiresAtMs: now + TTL_MS, createdAtMs: now });
    tx.set(owner, { active, updatedAtMs: now });
  });
  return { reservationId: id, period: 'individual-observation', maxOutputTokens: defaultMaxOutputTokens };
}
async function transition(args, next, terminal, deps = {}) {
  const store = deps.store || subiDb;
  const ref = refs(store, args.reservationId);
  return store.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw coded('ACCOUNTING_UNAVAILABLE');
    const doc = snap.data() || {};
    if (doc.terminal) {
      if (!terminal) throw coded('REQUEST_ALREADY_PROCESSED');
      return { alreadyTerminal: true };
    }
    const now = deps.nowMs ?? Date.now();
    if (!terminal && doc.expiresAtMs <= now) throw coded('REQUEST_ALREADY_PROCESSED');
    if (!terminal && ((next === 'dispatched' && doc.state !== 'reserved') || (next === 'started' && doc.state !== 'dispatched'))) {
      throw coded('REQUEST_IN_PROGRESS');
    }
    if (terminal) {
      const owner = store.collection('individualTurnOwners').doc(doc.ownerId);
      const index = await tx.get(owner);
      const active = { ...((index.exists ? index.data() : {})?.active || {}) };
      delete active[args.reservationId];
      tx.set(owner, { active, updatedAtMs: now });
    }
    tx.set(ref, { ...doc, state: next, terminal, updatedAtMs: now });
    return { alreadyTerminal: false, charged: 0 };
  });
}
module.exports = {
  reserveUsage,
  markDispatched: (args, deps) => transition(args, 'dispatched', false, deps),
  markStarted: (args, deps) => transition(args, 'started', false, deps),
  commitUsage: (args, deps) => transition(args, args.finalState || 'completed', true, deps),
  failBeforeStart: (args, deps) => transition(args, 'released', true, deps),
  failDispatched: (args, deps) => transition(args, 'failed', true, deps),
  finalizeStartedUnknownUsage: (args, deps) => transition(args, 'unknown', true, deps),
  finalizeAcceptedUnknownUsage: (args, deps) => transition(args, 'unknown', true, deps),
};
