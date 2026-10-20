// functions-subi/src/routes/managedChat.js
// Managed chat gateway (Phase 8 transport + Phase 9A quota, TEXT ONLY,
// local-only — NOT deployed).
//
// POST /chat streams provider-neutral SSE for an authorized managed user.
// Every request revalidates, from server-side authorities only:
//   0. request shape validation (pure CPU, zero store access; client
//      carries no authority either way)
//   1. requireAuth({ managedOnly: true }) → trusted req.subi, then the
//      managed-chat operational gate (disabled/test/enabled); the test
//      allowlist never bypasses the authorities below
//   2. resolveSubiAccess (Access)
//   3. shared effective-model resolver (model assignment) + approved doc
//      lookup (server-only upstreamModelId)
//   4. resolveEffectiveMonthlyLimit (fast-path config check)
//   5. usageQuota.reserveUsage (atomic reservation; limit re-read in-txn)
//   6. markDispatched (durable provider-risk boundary) BEFORE fetch;
//      stream with reserved max_tokens; markStarted on provider accept;
//      commit exact actuals, conservative-charge on unknown usage, or
//      zero-charge terminal failure on definite provider rejection.
//      upstreamDispatched (route-owned) — never callback success — decides
//      whether an abnormal end may release (pre-dispatch only). A
//      markStarted outage after a 2xx charges via finalizeAcceptedUnknownUsage
//      and never releases; the client receives no answer text in that case.
//      Accounting runs even when response headers/socket fail.
//
// The client sends ONLY { requestId, modelKey, messages }. Unknown fields,
// system roles, client token counts, and every client authority claim are
// rejected. The upstreamModelId and managed key live in backend memory only
// and never reach the wire, logs, or errors.
//
// BOUNDARY: no Secrets import here (the service resolves the key AFTER
// reservation), no legacy recordUsage calls (single quota finalization
// path), no prompt/completion logging.

const express = require("express");
const crypto = require('node:crypto');
const freeCapacity = require('../services/managedFreeCapacityService');
const { normalizeRetryAfterMs } = require('../utils/providerRetryTiming');
const accessService = require("../services/accessService");
const chatConfig = require("../services/managedChatConfigService");
const effectiveModels = require("../services/effectiveModelService");
const monthlyLimits = require("../services/monthlyLimitService");
const usageQuota = require("../services/usageQuotaService");
const managedChatValidator = require("../services/managedChatValidator");
const managedChatService = require("../services/managedChatService");
const { getUserProfile, getSchool } = require('../services/learnsmartDirectoryService');
const { evaluateSubiCodeEntitlement } = require('../services/subiCodeEntitlementService');
const { requireAuth } = require("../middleware/auth");
const { errorBody, safeCode, statusFor } = require("../utils/redact");
const { classifyStoreErrorCode } = require("../utils/storeErrorClass");
const { classifyDomainCode, classifyErrorCodeType, classifyErrorKind, classifyErrorOrigin } = require("../utils/errorOrigin");

// Fixed dispatch-phase vocabulary for the stage diagnostic (Phase 9B.2J).
// Must match the checkpoints inside usageQuotaService.markDispatched.
// Anything else (including a missing marker) reports as unknown.
const DISPATCH_PHASES = new Set([
  "pre_transaction",
  "transaction_entered",
  "reservation_read",
  "user_read",
  "writes_queued",
]);
const { create: createFinalizer } = require("./_finalizeWithRetry");
const { info: logInfo, warn: logWarn, error: logError, hashRequestId } = require("../utils/structuredLogger");

// Phase 9B.1A: a single-execution finalizer is created with a chosen
// `kind` and bound params. The inner action is invoked at most once;
// repeated calls return the cached structured result. The result object
// is the route's authoritative view of accounting status:
//   { settled: true,  accountingFinalized: true,  outcome, code: "OK", ... }
//   { settled: false, accountingFinalized: false, code: "ACCOUNTING_UNAVAILABLE", ... }
// The route reads `accountingFinalized` and emits ACCOUNTING_UNAVAILABLE
// to the client if false. It NEVER silently drops a finalization failure.
function onceFinalizer({ kind, params }) {
  return createFinalizer({ kind, params, deps: { quota: usageQuota } });
}

function cleanUsageNumbers(value) {
  const u = (value && typeof value === "object") ? value : {};
  const inn = Number.isSafeInteger(u.inputTokens) && u.inputTokens >= 0 ? u.inputTokens : 0;
  const out = Number.isSafeInteger(u.outputTokens) && u.outputTokens >= 0 ? u.outputTokens : 0;
  return { inputTokens: inn, outputTokens: out, total: inn + out };
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendError(res, headersSent, code, retryAfterMs) {
  // Phase 9B.2A: every post-header SSE error passes through the same
  // approved safeCode normalization as pre-header JSON errors. Raw store /
  // provider codes (e.g. UNAVAILABLE) can never reach the wire here.
  const safe = safeCode(code);
  const retry = normalizeRetryAfterMs(retryAfterMs);
  if (!headersSent) {
    const body = errorBody(safe);
    if (retry !== undefined) body.error.retryAfterMs = retry;
    return res.status(statusFor(safe)).json(body);
  }
  try {
    writeEvent(res, "error", { code: safe, message: "Request failed.", ...(retry === undefined ? {} : { retryAfterMs: retry }) });
  } catch (_) {
    // Client already gone; nothing to do.
  }
  try {
    res.end();
  } catch (_) {
    // best-effort only
  }
}

function router() {
  const r = express.Router();

  // See managedAccess.js: managedOnly is route-scoped, never app-level.
  r.post("/chat", requireAuth({ managedOnly: true }), async (req, res) => {
    let validated;
    try {
      validated = managedChatValidator.validateChatBody(req.body);
    } catch (err) {
      const code = err && err.code === "REQUEST_TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST";
      return res.status(statusFor(code)).json(errorBody(code));
    }
    const ctx = req.subi || {};
    // Legacy school-token transport. Current extension individuals use
    // /agent/turn; this route must never apply school token gates to them.
    if (ctx.accountType === 'individual') {
      return res.status(statusFor('MANAGED_CHAT_DISABLED')).json(errorBody('MANAGED_CHAT_DISABLED'));
    }

    // 1. Operational gate (after auth, after shape validation): rejects
    // disabled/test-miss before any policy/quota work. Never reveals
    // test membership. Separate from Global SUBI Access (WHO vs runtime).
    try {
      const config = await chatConfig.getManagedChatConfig();
      const gate = chatConfig.evaluateChatAvailability(config, ctx.uid);
      if (!gate.allowed) {
        return res.status(statusFor("MANAGED_CHAT_DISABLED")).json(errorBody("MANAGED_CHAT_DISABLED"));
      }
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
    }

    // 2. Access preflight (extension-cached access is display only).
    let access;
    try {
      access = await accessService.resolveSubiAccess({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        accountType: ctx.accountType,
      });
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
    }
    if (!access.allowed) {
      return res.status(statusFor("SUBI_ACCESS_DISABLED")).json(errorBody("SUBI_ACCESS_DISABLED"));
    }

    // The legacy school transport shares the same current subscription
    // authority as the agent transport; cached login admission is advisory.
    try {
      const profile = await getUserProfile(ctx.uid);
      if (!profile) return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE'));
      if (profile.accountType !== 'school') return res.status(403).json(errorBody('ACCOUNT_TYPE_UNSUPPORTED'));
      const school = profile.schoolId ? await getSchool(profile.schoolId) : null;
      if (!school) return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE'));
      if (school.accountType !== 'school') return res.status(403).json(errorBody('FORBIDDEN'));
      const entitlement = evaluateSubiCodeEntitlement({ accountType: 'school', userSubscription: profile.subscription || null, schoolSubscription: school.subscription || null });
      if (!entitlement.allowed) return res.status(statusFor(entitlement.code)).json(errorBody(entitlement.code));
    } catch (_) { return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE')); }

    // 3. Model preflight via the shared resolver seam (same authority as
    // GET /managed/models). Never trust prior extension fetches.
    let effective;
    try {
      effective = await effectiveModels.resolveEffectiveModels(
        { uid: ctx.uid, schoolId: ctx.schoolId, role: ctx.role, accountType: ctx.accountType },
        { basis: access.basis }
      );
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
    }
    const allowedKeys = new Set((effective.models || []).map((m) => m && m.modelKey));
    if (!allowedKeys.has(validated.modelKey)) {
      return res.status(statusFor("MODEL_NOT_ALLOWED")).json(errorBody("MODEL_NOT_ALLOWED"));
    }
    let upstreamModelId;
    try {
      upstreamModelId = await effectiveModels.resolveUpstreamModelId(validated.modelKey);
    } catch (err) {
      const code = err && err.code === "MODEL_NOT_AVAILABLE" ? "MODEL_NOT_AVAILABLE" : "INTERNAL";
      return res.status(statusFor(code)).json(errorBody(code));
    }

    // NOTE: request validation intentionally stays FIRST (before the gate):
    // it is pure CPU shape-checking with zero store access, so malformed
    // bodies are rejected before any Firestore read. Client carries no
    // authority either way.

    // 4. Monthly-limit configuration preflight (fast path; the reservation
    // transaction re-resolves the limit atomically — see step 5).
    let limit;
    try {
      limit = await monthlyLimits.resolveEffectiveMonthlyLimit({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        accountType: ctx.accountType,
      });
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
    }
    if (!limit || limit.configured !== true) {
      return res.status(statusFor("MONTHLY_LIMIT_NOT_CONFIGURED")).json(errorBody("MONTHLY_LIMIT_NOT_CONFIGURED"));
    }
    if (limit.monthlyTokenLimit === 0) {
      return res.status(statusFor("MONTHLY_LIMIT_EXCEEDED")).json(errorBody("MONTHLY_LIMIT_EXCEEDED"));
    }

    // 5. Atomic quota reservation (Phase 9A). Re-reads the CURRENT limit
    // inside the transaction, sweeps stale entries, enforces idempotency.
    // No key resolution and no provider call happen before this succeeds.
    // No server-owned system prompt exists today (0 bytes); the estimator
    // signature carries it for future use.
    const finalizeBaseParams = {
      reservationId: null, // set after reservation succeeds
      period: null,
      modelKey: validated.modelKey,
      requestId: validated.requestId,
    };
    let reservation;
    try {
      reservation = await usageQuota.reserveUsage({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        accountType: ctx.accountType,
        modelKey: validated.modelKey,
        requestId: validated.requestId,
        inputUpperBound: usageQuota.estimateInputUpperBound(validated.messages, 0),
        defaultMaxOutputTokens: usageQuota.DEFAULT_MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
      return res.status(statusFor(code)).json(errorBody(code));
    }
    finalizeBaseParams.reservationId = reservation.reservationId;
    finalizeBaseParams.period = reservation.period;

    // 6. Stream. Upstream + key stay inside managedChatService memory.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    let headersSent = false;
    const upstream = new AbortController();
    let streamDone = false;
    const onClientClose = () => {
      // res 'close' fires on disconnect AND on normal finish. Only abort
      // upstream while the stream is still open (body completion alone
      // must never be confused with a disconnect).
      if (!streamDone && !res.writableEnded) {
        try {
          upstream.abort();
        } catch (_) {
          // best-effort only
        }
      }
    };
    res.on("close", onClientClose);
    try {
      res.flushHeaders();
      headersSent = true;
    } catch (_) {
      // Headers unwritable (client gone before streaming). Accounting still
      // runs: streamManagedChat was never invoked, so no upstream dispatch
      // is possible — release here is provably safe (RESERVED only).
      // The result is awaited BEFORE the response handler returns so the
      // finalization state is durable. Failure is propagated to the next
      // accounting attempt (TTL sweep will release the RESERVED doc).
      const preReleaseFinalizer = onceFinalizer({
        kind: "release",
        params: Object.assign({}, finalizeBaseParams),
      });
      const preReleaseResult = await preReleaseFinalizer();
      if (!preReleaseResult.accountingFinalized) {
        logWarn("managed-chat-preheaders-release-failed", {
          reservationId: finalizeBaseParams.reservationId,
          period: finalizeBaseParams.period,
        });
      }
      try {
        res.removeListener("close", onClientClose);
      } catch (_) {
        // best-effort only
      }
      return;
    }
    writeEvent(res, "start", { requestId: validated.requestId, modelKey: validated.modelKey });
    // Route-owned risk tracking: ONLY this flag (set after the durable
    // DISPATCHED write commits) may authorize conservative accounting.
    // Callback success/failure alone never decides — a markStarted outage
    // after a 2xx must still charge, never release.
    let upstreamDispatched = false;
    let providerAccepted = false;
    const onBeforeProviderDispatch = async () => {
      const dispatchStart = Date.now();
      try {
        await usageQuota.markDispatched({
          reservationId: reservation.reservationId,
          period: reservation.period,
          uid: ctx.uid,
          schoolId: ctx.schoolId,
          role: ctx.role,
        });
      } catch (err) {
        // Phase 9B.2C/9B.2F: single safe diagnostic at the first
        // dispatch-failure boundary. The error is rethrown unchanged —
        // downstream release + safeCode handling below is preserved exactly.
        try {
          const errorOrigin = classifyErrorOrigin(err);
          const domainCode = errorOrigin === "domain" ? classifyDomainCode(err) : null;
          const rawPhase = err !== null && typeof err === "object" ? err.dispatchPhase : undefined;
          logWarn("managed-chat-stage-failure", {
            stage: "mark_dispatched",
            storeCodeClass: classifyStoreErrorCode(err),
            errorOrigin,
            ...(domainCode === null ? {} : { domainCodeClass: domainCode }),
            codeType: classifyErrorCodeType(err),
            errorKind: classifyErrorKind(err),
            dispatchPhase: typeof rawPhase === "string" && DISPATCH_PHASES.has(rawPhase) ? rawPhase : "unknown",
            requestIdHash: hashRequestId(validated.requestId),
            period: reservation.period,
            reservationId: reservation.reservationId,
            modelKey: validated.modelKey,
            durationMs: Date.now() - dispatchStart,
          });
        } catch (_) {
          // Observability must never affect accounting.
        }
        throw err;
      }
      upstreamDispatched = true;
    };
    // Acceptance knowledge is established by the 2xx itself (service sets
    // providerAccepted on all post-accept errors) and by the explicit flag
    // below — never solely by markStarted success. A store outage here
    // cannot erase the knowledge that inference may have started.
    const onProviderAccepted = async () => {
      providerAccepted = true;
      try {
        await usageQuota.markStarted({
          reservationId: reservation.reservationId,
          period: reservation.period,
        });
      } catch (markErr) {
        // Provider already returned 2xx: NEVER release. Abort the stream
        // (client receives no answer text) and conservatively charge via
        // finalizeAcceptedUnknownUsage with bounded retry. If the
        // conservative charge itself cannot persist, the durable DISPATCHED
        // record remains recoverable via TTL sweep — and we surface
        // ACCOUNTING_UNAVAILABLE on this response so the failure is
        // observable.
        let chargeFinalizer;
        try {
          chargeFinalizer = onceFinalizer({
            kind: "charge-accepted-unknown",
            params: Object.assign({}, finalizeBaseParams, { finalState: "failed" }),
          });
        } catch (_) {
          chargeFinalizer = null;
        }
        if (chargeFinalizer) {
          const r = await chargeFinalizer();
          if (!r.accountingFinalized) {
            const err = new Error("accounting unavailable after provider accept");
            err.code = "ACCOUNTING_UNAVAILABLE";
            err.providerAccepted = true;
            err.usage = { inputTokens: 0, outputTokens: 0 };
            throw err;
          }
        }
        const err = new Error("accounting finalized after provider accept");
        err.code = "PROVIDER_UNAVAILABLE";
        err.providerAccepted = true;
        err.usage = { inputTokens: 0, outputTokens: 0 };
        throw err;
      }
    };
    // Phase 9B.1A: track whether the route's finalization succeeded. The
    // result is used to override the client response with ACCOUNTING_UNAVAILABLE
    // when the durable write could not be committed.
    let accountingFinalized = false;
    let accountingErrorCode = null;
    let freeLease = null;
    try {
      const usage = await managedChatService.streamManagedChat({
        requestId: validated.requestId,
        upstreamModelId,
        messages: validated.messages,
        maxOutputTokens: reservation.maxOutputTokens,
        onBeforeProviderDispatch: async () => {
          freeLease = await freeCapacity.acquireFreeCapacity({ upstreamModelId, attemptId: crypto.randomUUID() });
          await onBeforeProviderDispatch();
        },
        onProviderAccepted,
        signal: upstream.signal,
        onDelta: async (text) => {
          writeEvent(res, "delta", { text });
        },
      });
      const actual = cleanUsageNumbers(usage);
      const commitFinalizer = onceFinalizer({
        kind: "commit",
        params: Object.assign({}, finalizeBaseParams, {
          actualInputTokens: actual.inputTokens,
          actualOutputTokens: actual.outputTokens,
        }),
      });
      const r = await commitFinalizer();
      accountingFinalized = r.accountingFinalized;
      if (!accountingFinalized) accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
      streamDone = true;
      writeEvent(res, "done", { requestId: validated.requestId, modelKey: validated.modelKey });
      try {
        res.end();
      } catch (_) {
        // best-effort only
      }
      logInfo("managed-chat-stream", {
        requestIdHash: hashRequestId(validated.requestId),
        period: reservation.period,
        reservationId: reservation.reservationId,
        modelKey: validated.modelKey,
        stage: "stream",
        code: r.accountingFinalized ? "OK" : "ACCOUNTING_UNAVAILABLE",
        providerAccepted,
        accountingOutcome: r.accountingFinalized ? "finalized" : "failed",
        durationMs: r && typeof r.attempt === "number" ? undefined : undefined,
      });
    } catch (err) {
      streamDone = true;
      const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
      if (freeLease && code === 'PROVIDER_RATE_LIMITED' && Number.isSafeInteger(err.sharedFreeResetAtMs)) {
        try { await freeCapacity.recordFreeCapacityReset({ retryAtMs: err.sharedFreeResetAtMs }); }
        catch (_) { logWarn('managed-free-capacity-reset', { code: 'CAPACITY_RESET_PENDING' }); }
      }
      const partial = cleanUsageNumbers(err && err.usage);
      const terminalState = code === "CANCELLED" ? "cancelled" : "failed";
      let pickedFinalizer = null;
      if (code === "DISPATCH_ABORTED") {
        // Aborted synchronously before fetch: proven never dispatched.
        // Zero-charge terminal failure (no inference possible).
        pickedFinalizer = onceFinalizer({
          kind: "fail",
          params: Object.assign({}, finalizeBaseParams),
        });
      } else if (!upstreamDispatched) {
        // No durable dispatch exists: release in full, zero charge.
        pickedFinalizer = onceFinalizer({
          kind: "release",
          params: Object.assign({}, finalizeBaseParams),
        });
      } else if (code === "PROVIDER_AUTH_FAILED" || code === "PROVIDER_RATE_LIMITED") {
        // Definitive provider rejection: no inference stream was accepted.
        // Zero-charge terminal failure; if this write cannot persist, the
        // durable DISPATCHED record later charges via stale recovery.
        pickedFinalizer = onceFinalizer({
          kind: "fail",
          params: Object.assign({}, finalizeBaseParams),
        });
      } else if (code === "ACCOUNTING_UNAVAILABLE") {
        // markStarted failed: the route's onProviderAccepted already
        // attempted finalizeAcceptedUnknownUsage with retry. Treat the
        // current attempt as the one that already tried; do NOT switch to
        // a different finalizer (would risk double-charge on the durable
        // DISPATCHED record). Surface ACCOUNTING_UNAVAILABLE; TTL sweep
        // remains the backstop.
        accountingFinalized = false;
        accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
        logError("managed-chat-error", {
          requestIdHash: hashRequestId(validated.requestId),
          period: reservation.period,
          reservationId: reservation.reservationId,
          modelKey: validated.modelKey,
          stage: "markstarted-finalize-failed",
          code: "ACCOUNTING_UNAVAILABLE",
          providerAccepted: true,
        });
      } else if (usageQuota.classifyFinalization({ upstreamDispatched, usage: partial }) === "commit") {
        // Post-dispatch with known partial usage: commit exactly once.
        pickedFinalizer = onceFinalizer({
          kind: "commit",
          params: Object.assign({}, finalizeBaseParams, {
            actualInputTokens: partial.inputTokens,
            actualOutputTokens: partial.outputTokens,
            finalState: terminalState,
          }),
        });
      } else {
        // Post-dispatch with unrecoverable usage: conservative full charge.
        // Covers cancel/timeout/5xx/network ambiguity — never a zero release.
        pickedFinalizer = onceFinalizer({
          kind: "charge",
          params: Object.assign({}, finalizeBaseParams, { finalState: terminalState }),
        });
      }
    if (pickedFinalizer) {
      const r = await pickedFinalizer();
      accountingFinalized = r.accountingFinalized;
      if (!accountingFinalized) {
        accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
      }
    }
      if (code === "CANCELLED" || code === "DISPATCH_ABORTED") {
        try {
          res.end();
        } catch (_) {
          // best-effort only
        }
        return;
      }
      // Surface typed accounting failure to the client in preference to
      // the bare provider code, so the failure is observable and the TTL
      // sweep remains the durable backstop.
      if (accountingErrorCode === "ACCOUNTING_UNAVAILABLE") {
        sendError(res, headersSent, "ACCOUNTING_UNAVAILABLE");
        return;
      }
      if (code === "AI_NOT_CONFIGURED" || code === "SECRET_UNAVAILABLE") {
        sendError(res, headersSent, "AI_CONNECTION_UNAVAILABLE");
        return;
      }
      sendError(res, headersSent, code, err && err.retryAfterMs);
    } finally {
      try { await freeCapacity.releaseFreeCapacity(freeLease); } catch (_) { logWarn('managed-free-capacity-release', { code: 'CAPACITY_RELEASE_PENDING' }); }
      try {
        res.removeListener("close", onClientClose);
      } catch (_) {
        // best-effort only
      }
    }
  });

  return r;
}

module.exports = { managedChatRouter: router };
