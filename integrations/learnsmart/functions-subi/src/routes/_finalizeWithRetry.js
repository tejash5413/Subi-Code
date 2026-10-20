// functions-subi/src/routes/_finalizeWithRetry.js
// Phase 9B.1A: bounded, awaited, idempotent finalization retry.
//
// Single-execution guarantee: the inner action is called at most once per
// `kind`. Repeated calls with the same kind return the FIRST result object
// (settled), never re-invoke the action. Different kinds still produce
// distinct results.
//
// Retry policy: at most MAX_ATTEMPTS total tries. Bounded delays via the
// injected `sleep` (default real setTimeout). No setImmediate, no
// background tasks, no unawaited promises.
//
// Failure surfacing: the helper NEVER silently swallows a finalization
// failure. It always returns a structured result with `accountingFinalized`
// (true|false) and `code`. The route reads this result and decides
// client response (ACCOUNTING_UNAVAILABLE for any false result).
//
// Idempotency: each kind invokes the matching usageQuota helper which is
// itself idempotent against a terminal reservation. So retrying commit
// after a possibly-successful commit is safe — the second call sees the
// terminal doc and returns alreadyTerminal: true without double-charging.

const { hashRequestId, warn, error: logError, info } = require("../utils/structuredLogger");
const { safeCode } = require("../utils/redact");

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 50, 150];

const PROVIDER_RISK_KINDS = new Set(["commit", "charge", "fail"]);
const PRE_PROVIDER_KINDS = new Set(["release"]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSafeFields({ requestId, period, reservationId, modelKey, stage, code, retryAttempt, providerAccepted, accountingOutcome, durationMs }) {
  const f = {
    stage,
    safeCode: safeCode(code || "INTERNAL"),
  };
  if (requestId) f.requestIdHash = hashRequestId(requestId);
  if (period) f.period = String(period);
  if (reservationId) f.reservationId = String(reservationId).slice(0, 32);
  if (modelKey) f.modelKey = String(modelKey).slice(0, 64);
  if (typeof retryAttempt === "number") f.retryAttempt = retryAttempt;
  if (typeof providerAccepted === "boolean") f.providerAccepted = providerAccepted;
  if (accountingOutcome) f.accountingOutcome = String(accountingOutcome);
  if (typeof durationMs === "number") f.durationMs = Math.max(0, Math.min(2147483647, Math.round(durationMs)));
  return f;
}

// Decide which finalizer to call. The caller chooses the kind and provides
// the bound parameters. We do NOT silently switch kinds on failure — that
// would either (a) double-charge on ambiguous commit, or (b) zero-release
// after provider risk exposure. Idempotency is guaranteed by usageQuota
// helpers themselves.
//
// params shape:
//   { reservationId, period, modelKey, requestId, providerAccepted }
async function runOnce(kind, params, deps) {
  const quota = deps.quota;
  switch (kind) {
    case "commit":
      return quota.commitUsage({
        reservationId: params.reservationId,
        period: params.period,
        actualInputTokens: params.actualInputTokens,
        actualOutputTokens: params.actualOutputTokens,
        finalState: params.finalState || "completed",
      });
    case "release":
      return quota.failBeforeStart({
        reservationId: params.reservationId,
        period: params.period,
      });
    case "fail":
      return quota.failDispatched({
        reservationId: params.reservationId,
        period: params.period,
      });
    case "charge":
      return quota.finalizeStartedUnknownUsage({
        reservationId: params.reservationId,
        period: params.period,
        finalState: params.finalState || "failed",
      });
    case "charge-accepted-unknown":
      return quota.finalizeAcceptedUnknownUsage({
        reservationId: params.reservationId,
        period: params.period,
        finalState: params.finalState || "failed",
      });
    default:
      throw coded(`unknown finalization kind: ${kind}`, "INTERNAL");
  }
}

function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function makeFinalizer({ kind, params, deps }) {
  let settled = null;
  let attempt = 0;
  const sleep = (deps && deps.sleep) || defaultSleep;
  const startedAt = Date.now();
  const ctx = {
    requestId: params.requestId,
    period: params.period,
    reservationId: params.reservationId,
    modelKey: params.modelKey,
    providerAccepted: params.providerAccepted,
  };

  async function finalizeOnce() {
    if (settled) return settled;
    let lastErr = null;
    for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_MS[attempt - 1] > 0) {
        try {
          await sleep(BACKOFF_MS[attempt - 1]);
        } catch (_) {
          // sleep is injectable; never let a sleep failure escape
        }
      }
      try {
        const out = await runOnce(kind, params, deps);
        settled = {
          settled: true,
          accountingFinalized: true,
          outcome: out,
          code: "OK",
          attempt,
          kind,
        };
        info("managed-chat-finalized", Object.assign(
          buildSafeFields(Object.assign({}, ctx, { retryAttempt: attempt, accountingOutcome: "finalized" })),
          { durationMs: Date.now() - startedAt }
        ));
        return settled;
      } catch (err) {
        lastErr = err;
        const code = (err && err.code) || "INTERNAL";
        const fields = buildSafeFields(Object.assign({}, ctx, {
          retryAttempt: attempt,
          code,
          accountingOutcome: "retry",
          durationMs: Date.now() - startedAt,
        }));
        if (attempt < MAX_ATTEMPTS) {
          warn("managed-chat-finalize-retry", fields);
        } else {
          logError("managed-chat-finalize-error", fields);
        }
      }
    }
    settled = {
      settled: false,
      accountingFinalized: false,
      code: "ACCOUNTING_UNAVAILABLE",
      attempt: MAX_ATTEMPTS,
      kind,
      lastErrorCode: (lastErr && lastErr.code) || "INTERNAL",
    };
    const failureFields = buildSafeFields(Object.assign({}, ctx, {
      retryAttempt: MAX_ATTEMPTS,
      code: "ACCOUNTING_UNAVAILABLE",
      accountingOutcome: "failed",
      durationMs: Date.now() - startedAt,
    }));
    logError("managed-chat-finalize-failed", failureFields);
    return settled;
  }
  return finalizeOnce;
}

// Public: create a finalizer (single-shot) for the given kind.
// Subsequent calls on the same finalizer return the cached result.
function create({ kind, params, deps }) {
  if (!PROVIDER_RISK_KINDS.has(kind) && !PRE_PROVIDER_KINDS.has(kind)) {
    throw coded(`createFinalizer: unsupported kind ${kind}`, "INTERNAL");
  }
  if (!params || typeof params.reservationId !== "string" || !params.reservationId) {
    throw coded("createFinalizer: missing reservationId", "INVALID_REQUEST");
  }
  if (!params.period) {
    throw coded("createFinalizer: missing period", "INVALID_REQUEST");
  }
  return makeFinalizer({ kind, params, deps });
}

module.exports = {
  create,
  MAX_ATTEMPTS,
  BACKOFF_MS,
  PROVIDER_RISK_KINDS,
  PRE_PROVIDER_KINDS,
};
