// functions-subi/src/routes/managedAgent.js
// Managed agent gateway (Phase 13, TOOL-CAPABLE, local-only — NOT deployed).
//
// POST /agent/turn streams normalized agent events for one provider turn.
// Every request revalidates from server-side authorities only:
//   0. protocol validation (pure CPU, zero store access)
//   1. requireAuth({ managedOnly: true }) → trusted req.subi, then the
//      managed-agent operational gate (disabled/test/enabled)
//   2. resolveSubiAccess (Access: global/school/individual precedence)
//   3. shared effective-model resolver + approved doc lookup (upstream id)
//      + agent capability check (capabilities.toolCalling must be true)
//   4. resolveEffectiveMonthlyLimit (fast-path config check)
//   5. usageQuota.reserveUsage (atomic reservation; id = sha256(uid + runId:index))
//   6. markDispatched BEFORE fetch; stream with reserved max_tokens;
//      markStarted on provider accept; commit exact actuals,
//      conservative-charge on unknown usage, or zero-charge terminal
//      failure on definite provider rejection.
//
// The client sends ONLY SubiManagedAgentProtocolV1 fields. System prompt,
// tool schemas, capability set, upstream id, and managed key stay server-side.
// The backend never executes local coding tools.
//
// BOUNDARY: no Secrets import here, no legacy recordUsage, no prompt logging.

const express = require("express");
const { normalizeRetryAfterMs } = require("../utils/providerRetryTiming");
const crypto = require("crypto");
const accessService = require("../services/accessService");
const agentConfig = require("../services/managedAgentConfigService");
const { getUserProfile, getSchool } = require("../services/learnsmartDirectoryService");
const { evaluateSubiCodeEntitlement } = require("../services/subiCodeEntitlementService");
const agentValidator = require("../services/managedAgentValidator");
const managedAgentService = require("../services/managedAgentService");
const freeCapacity = require('../services/managedFreeCapacityService');
const managedAgentTools = require("../services/managedAgentTools");
const effectiveModels = require("../services/effectiveModelService");
const monthlyLimits = require("../services/monthlyLimitService");
const usageQuota = require("../services/usageQuotaService");
const individualTurns = require("../services/individualTurnService");
const quotaModeService = require("../services/quotaModeService");
const individualCreditFlags = require("../services/individualCreditFlags");
const individualCreditAccountService = require("../services/individualCreditAccountService");
const individualCreditQuota = require("../services/individualCreditQuotaService");
const individualCreditReady = require("../services/individualCreditReadyService");
const creditShadowService = require("../services/individualCreditShadowService");
const approvedModelService = require("../services/approvedModelService");
const pricingSnapshot = require("../services/pricingSnapshot");
const creditMath = require("../services/creditMath");
const modelCatalog = require("../services/modelCatalogService");
const { requireAuth } = require("../middleware/auth");
const { errorBody, safeCode, statusFor } = require("../utils/redact");
const { classifyStoreErrorCode } = require("../utils/storeErrorClass");
const { create: createFinalizer } = require("./_finalizeWithRetry");
const { info: logInfo, warn: logWarn, error: logError, hashRequestId } = require("../utils/structuredLogger");

function onceFinalizer({ kind, params, quota = usageQuota }) {
  return createFinalizer({ kind, params, deps: { quota } });
}

// Shadow finalize wrapper: best-effort ONLY. A shadow store/calculation
// failure must never fail the live (non-enforced) request.
async function finalizeShadowBestEffort({ uid, requestId, usage, outcome, dispatched }) {
  try {
    await creditShadowService.finalizeShadow({
      uid,
      requestId,
      inputTokens: usage && usage.inputTokens,
      outputTokens: usage && usage.outputTokens,
      outcome,
      dispatched,
    });
  } catch (_) {
    try {
      logWarn("credit_shadow.telemetry_failed", {
        requestIdHash: hashRequestId(String(requestId || "")),
        stage: "finalize",
      });
    } catch (_) {
      // Observability must never affect the turn.
    }
  }
}

function cleanUsageNumbers(value) {
  const u = (value && typeof value === "object") ? value : {};
  const inn = Number.isSafeInteger(u.inputTokens) && u.inputTokens >= 0 ? u.inputTokens : 0;
  const out = Number.isSafeInteger(u.outputTokens) && u.outputTokens >= 0 ? u.outputTokens : 0;
  return { inputTokens: inn, outputTokens: out, total: inn + out };
}

function writeEvent(res, event, data) {
  if (res.locals.nativeAgentWrite) return res.locals.nativeAgentWrite(event, data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendError(res, headersSent, code, httpStatus, retryAfterMs) {
  const safe = safeCode(code);
  if (!headersSent) {
    const timing = safe === "PROVIDER_RATE_LIMITED" ? normalizeRetryAfterMs(retryAfterMs) : undefined;
    return res.status(statusFor(safe)).json({ ...errorBody(safe), ...(timing !== undefined ? { retryAfterMs: timing } : {}) });
  }
  try {
    // httpStatus is a bare number for client retry classification only.
    const data = { code: safe, message: "Request failed." };
    const timing = safe === "PROVIDER_RATE_LIMITED" ? normalizeRetryAfterMs(retryAfterMs) : undefined;
    if (timing !== undefined) data.retryAfterMs = timing;
    if (typeof httpStatus === "number" && Number.isSafeInteger(httpStatus)) {
      data.httpStatus = httpStatus;
    }
    writeEvent(res, "error", data);
  } catch (_) {
    // best-effort
  }
  try {
    res.end();
  } catch (_) {
    // best-effort
  }
}

// Safe pre-stream denial log (Phase 13.5): gate/access/model/limit
// rejections return before any reservation, so they otherwise leave no
// trace. Structured fields only — never content, keys, or tokens.
function logGateDenial({ ctx, validated, stage, code }) {
  try {
    logWarn("managed-agent-gate-denial", {
      requestIdHash: hashRequestId(require('../services/managedAccountingIdentity').accountingRequestId(validated.clientRunId, validated.providerRequestIndex)),
      modelKey: validated.modelKey,
      stage,
      code: safeCode(code),
      role: String((ctx && ctx.role) || "").slice(0, 32),
    });
  } catch (_) {
    // Observability must never affect the denial.
  }
}

function fingerprintCanonical(validated) {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({
    modelKey: validated.modelKey,
    agentMode: validated.agentMode,
    turns: validated.canonicalTurns,
    toolCap: validated.toolCapabilityVersion,
    ...(validated.freeModelOnly === true ? { freeOnly: true } : {}),
    // Phase 21B.0: canonical validated host facts only (never raw input).
    // Identical facts contribute identically; changed facts mark a new
    // logical request. Absent preserves the legacy fingerprint shape input.
    hostCtx: validated.hostContext === undefined
      ? null
      : agentValidator.serializeHostContext(validated.hostContext),
    ...(validated.nativeRequest ? { nativeRequest: validated.nativeRequest } : {}),
  }), "utf8");
  return h.digest("hex").slice(0, 32);
}

// Upstream finish reasons are a closed provider enum. Only allowlisted
// values ride the done event (extension diagnostics); anything else is
// omitted rather than forwarded.
const DONE_FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "error"]);
function finishReasonForLog(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return DONE_FINISH_REASONS.has(v) ? v : "";
}

function router() {
  const r = express.Router();

  // Capability discovery is not account/model/quota admission. POST still runs
  // every existing server authority. Off by default until explicitly deployed.
  r.get('/agent/native/status', requireAuth({ managedOnly: true }), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return process.env.SUBI_NATIVE_AGENT_ENABLED === '1'
      ? res.json({ protocolVersion: 1, textOnly: true })
      : res.status(503).json(errorBody('MANAGED_AGENT_DISABLED'));
  });

  r.post(["/agent/turn", "/agent/chat/completions"], requireAuth({ managedOnly: true }), async (req, res) => {
    if (req.path === '/agent/chat/completions') {
      if (process.env.SUBI_NATIVE_AGENT_ENABLED !== '1') return res.status(503).json(errorBody('MANAGED_AGENT_DISABLED'));
      try {
        res.locals.nativeNonStreaming = req.body?.stream !== true;
        req.body = require('../services/managedNativeAgent').fromChat(req.body, req.headers);
      } catch (_) { return res.status(400).json(errorBody('INVALID_REQUEST')); }
    }
    if (req.body && req.body.nativeRequest !== undefined && process.env.SUBI_NATIVE_AGENT_ENABLED !== '1')
      return res.status(503).json(errorBody('MANAGED_AGENT_DISABLED'));
    let validated;
    try {
      validated = agentValidator.validateAgentBody(req.body);
    } catch (err) {
      const code = err && err.code === "REQUEST_TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST";
      // Validation denials otherwise leave no trace (no gate stage reached).
      // Validator messages are static check labels — never request content.
      try {
        logWarn("managed-agent-validation-denial", {
          reason: String((err && err.message) || "unknown").slice(0, 120),
          code: safeCode(code),
        });
      } catch (_) {
        // Observability must never affect the denial.
      }
      return res.status(statusFor(code)).json(errorBody(code));
    }
    if (validated.nativeRequest) res.locals.nativeAgentWrite = require('../services/managedNativeAgent').stream(res, validated.modelKey, !res.locals.nativeNonStreaming);
    const ctx = req.subi || {};
    // Deterministic per-turn idempotency identity: uid + runId:index.
    const turnRequestId = require('../services/managedAccountingIdentity').accountingRequestId(validated.clientRunId, validated.providerRequestIndex);
    const fingerprint = fingerprintCanonical(validated);
    // Safe per-turn dispatch record (Phase 16 production): mode, capability,
    // and provider tool count only. Never UIDs, prompts, args, or model ids
    // beyond the internal modelKey already present in stream logs.
    try {
      logInfo("managed-agent-turn", {
        requestIdHash: hashRequestId(turnRequestId),
        modelKey: validated.modelKey,
        agentMode: validated.agentMode,
        capabilityVersion: validated.toolCapabilityVersion,
        toolCount: managedAgentTools.buildManagedAgentTools(
          validated.toolCapabilityVersion,
          validated.agentMode,
          validated.agentSkillsContext
        ).length,
        // Phase 21B.0: safe host-context presence counters only. Never
        // paths, names, full JSON, UIDs, or provider identity.
        hostContextPresent: validated.hostContext !== undefined,
        osFamily: (validated.hostContext && validated.hostContext.osFamily) || "-",
        shellCount: (validated.hostContext && Array.isArray(validated.hostContext.shellAvailable))
          ? validated.hostContext.shellAvailable.length : 0,
        rootCount: (validated.hostContext && validated.hostContext.workspace &&
          typeof validated.hostContext.workspace.rootCount === "number")
          ? validated.hostContext.workspace.rootCount : -1,
      });
    } catch (_) {
      // Observability must never affect the turn.
    }

    // Operational config for test/production probe policy below. Hoisted so
    // the verify preflight can distinguish test-mode probes from production.
    // Dual quota routing: school -> tokens, individual -> credits.
    // ctx.accountType is directory-authoritative via requireAuth (never body).
    // Unknown/missing account type fails closed here: no provider, no quota.
    let quotaMode;
    try {
      quotaMode = quotaModeService.resolveQuotaMode({ accountType: ctx.accountType });
    } catch (_) {
      logGateDenial({ ctx, validated, stage: "quota_mode", code: "ACCOUNT_TYPE_UNSUPPORTED" });
      return res.status(statusFor("ACCOUNT_TYPE_UNSUPPORTED")).json(errorBody("ACCOUNT_TYPE_UNSUPPORTED"));
    }
    const creditFlags = await individualCreditFlags.getIndividualCreditFlags().catch(() => null);
    const creditEnforcement =
      quotaMode === "individual_credits" && creditFlags !== null && creditFlags.enforcementEnabled === true;
    const creditShadow =
      quotaMode === "individual_credits" && creditFlags !== null && creditFlags.shadowEnabled === true;
    const fullCaps = creditFlags !== null && creditFlags.fullAgentCapabilitiesEnabled === true;
    let agentCfg = null;
    try {
      const config = await agentConfig.getManagedAgentConfig();
      agentCfg = config;
      const gate = agentConfig.evaluateAgentAvailability(config, ctx.uid);
      if (!gate.allowed) {
        logGateDenial({ ctx, validated, stage: "agent_gate", code: "MANAGED_AGENT_DISABLED" });
        return res.status(statusFor("MANAGED_AGENT_DISABLED")).json(errorBody("MANAGED_AGENT_DISABLED"));
      }
      if (managedAgentTools.isAgentJobsCapability(validated.toolCapabilityVersion) && agentConfig.evaluateJobsCapability(config, ctx.uid) !== 'jobs_v1') return res.status(403).json(errorBody('MANAGED_AGENT_DISABLED'));
      if (managedAgentTools.isCoordinationCapability(validated.toolCapabilityVersion) && agentConfig.evaluateCoordinationCapability(config, ctx.uid) !== 'coordination_v1') return res.status(403).json(errorBody('MANAGED_AGENT_DISABLED'));
      if (managedAgentTools.isAgentJobsCapability(validated.toolCapabilityVersion) && validated.accountingPeriod !== require('../services/managedAccountingIdentity').accountingPeriod()) return res.status(409).json(errorBody('REQUEST_ALREADY_PROCESSED'));
      // Global individual runtime must never fall back to observation when
      // enforcement flags are missing, unreadable or explicitly switched off.
      // Test mode retains its allowlisted observation/shadow rollout behavior.
      if (quotaMode === "individual_credits" && gate.mode === "enabled" && !creditEnforcement) {
        logGateDenial({ ctx, validated, stage: "credit_configuration", code: "CREDITS_NOT_CONFIGURED" });
        return res.status(503).json(errorBody("CREDITS_NOT_CONFIGURED"));
      }
      // Phase 18 certification: agent_v2 BUILD carries the same terminal/
      // shell tools as terminal_v1, so the terminal entitlement and trusted-
      // subscription rechecks apply identically — scoped to build mode since
      // agent_v2 ASK/PLAN carry no terminal tools.
      // Phase 19C: agent_v3 BUILD carries the identical terminal/shell set.
      const isTerminalTurn = validated.toolCapabilityVersion === 'terminal_v1' ||
        ((validated.toolCapabilityVersion === 'agent_v2' || validated.toolCapabilityVersion === 'agent_v3' || (validated.toolCapabilityVersion === 'agent_skills_v1' || (validated.toolCapabilityVersion === 'agent_mcp_skills_v1' || validated.toolCapabilityVersion === 'agent_pty_skills_v1')) || managedAgentTools.isAgentJobsCapability(validated.toolCapabilityVersion)) && validated.agentMode === 'build');
      const fullCapsRoute = creditFlags !== null && creditFlags.fullAgentCapabilitiesEnabled === true;
      if (isTerminalTurn && (config.terminalEnabled !== true ||
          (!fullCapsRoute && agentConfig.evaluateTerminalCapability(config, ctx.uid) !== 'terminal'))) {
        return res.status(403).json(errorBody('AGENT_BUILD_LOCKED'));
      }
      if (isTerminalTurn) {
        // Recheck the trusted subscription on every terminal turn. A cached
        // access-status response is never authority to dispatch a provider.
        try {
          const profile = await getUserProfile(ctx.uid);
          const accountType = profile?.accountType || ctx.accountType;
          if (accountType !== 'individual' && accountType !== 'school') {
            return res.status(403).json(errorBody('ACCOUNT_TYPE_UNSUPPORTED'));
          }
          const schoolId = profile?.schoolId || ctx.schoolId;
          const school = accountType === 'school' && schoolId ? await getSchool(schoolId) : null;
          const entitlement = evaluateSubiCodeEntitlement({ accountType, userSubscription: profile?.subscription || null, schoolSubscription: school?.subscription || null });
          if (!entitlement.allowed) return res.status(403).json(errorBody('AGENT_BUILD_LOCKED'));
        } catch (_) {
          return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE'));
        }
      }
      const fileCapability = (creditFlags !== null && creditFlags.fullAgentCapabilitiesEnabled === true)
        ? "build"
        : agentConfig.evaluateFileCapability(config, ctx.uid);
      if (
        (managedAgentTools.isFileToolCapability(validated.toolCapabilityVersion) || validated.agentMode === "build") &&
        fileCapability !== "build"
      ) {
        logGateDenial({ ctx, validated, stage: "file_capability", code: "AGENT_BUILD_LOCKED" });
        return res.status(statusFor("AGENT_BUILD_LOCKED")).json(errorBody("AGENT_BUILD_LOCKED"));
      }
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
    }

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
      logGateDenial({ ctx, validated, stage: "access", code: "SUBI_ACCESS_DISABLED" });
      return res.status(statusFor("SUBI_ACCESS_DISABLED")).json(errorBody("SUBI_ACCESS_DISABLED"));
    }

    const requestAccounting = quotaMode === 'individual_credits' ? individualTurns : usageQuota;
    const finalizeTurn = ({ kind, params }) => onceFinalizer({ kind, params, quota: requestAccounting });

    let effective;
    let allowed = null;
    // Individual credit enforcement: active subscribers use ALL approved
    // enabled compatible models (pricing controls burn, not access).
    // Schools keep schoolModelPolicies enforcement unchanged.
    if (quotaMode === "individual_credits") {
      try {
        const reg = await approvedModelService.getApprovedModel(validated.modelKey);
        if (reg && reg.enabled === true) {
          allowed = {
            modelKey: reg.modelKey,
            displayName: reg.displayName,
            capabilities: reg.capabilities,
            contextLength: reg.contextLength,
            pricing: reg.pricing,
          };
        }
      } catch (_) {
        allowed = null;
      }
      if (!allowed) {
        logGateDenial({ ctx, validated, stage: "model_policy", code: "MODEL_NOT_ALLOWED" });
        return res.status(statusFor("MODEL_NOT_ALLOWED")).json(errorBody("MODEL_NOT_ALLOWED"));
      }
    } else {
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
      allowed = (effective.models || []).find((m) => m && m.modelKey === validated.modelKey);
      if (!allowed) {
        logGateDenial({ ctx, validated, stage: "model_policy", code: "MODEL_NOT_ALLOWED" });
        return res.status(statusFor("MODEL_NOT_ALLOWED")).json(errorBody("MODEL_NOT_ALLOWED"));
      }
    }
    if (!allowed.capabilities || allowed.capabilities.toolCalling !== true) {
      logGateDenial({ ctx, validated, stage: "model_capability", code: "AGENT_UNSUPPORTED_MODEL" });
      return res.status(statusFor("AGENT_UNSUPPORTED_MODEL")).json(errorBody("AGENT_UNSUPPORTED_MODEL"));
    }
    if (validated.canonicalTurns.some(turn => turn.images?.length) && !allowed.capabilities.inputModalities?.includes('image')) {
      logGateDenial({ ctx, validated, stage: 'model_capability', code: 'IMAGE_INPUT_UNAVAILABLE' });
      return res.status(statusFor('IMAGE_INPUT_UNAVAILABLE')).json(errorBody('IMAGE_INPUT_UNAVAILABLE'));
    }
    // Phase 16 production: an explicitly terminal-incompatible model never
    // reaches the provider for terminal_v1 turns — zero dispatch, zero usage
    // burn, zero recovery turns. Unknown (unmarked) models still probe while
    // managedAgentMode=test; production policy may fail them closed later.
    // Phase 18 certification: agent_v2 BUILD carries the same shell tools,
    // so the mark applies identically — scoped to build mode since agent_v2
    // ASK/PLAN carry no terminal tools.
    if (
      (validated.toolCapabilityVersion === 'terminal_v1' ||
        ((validated.toolCapabilityVersion === 'agent_v2' || validated.toolCapabilityVersion === 'agent_v3' || (validated.toolCapabilityVersion === 'agent_skills_v1' || (validated.toolCapabilityVersion === 'agent_mcp_skills_v1' || validated.toolCapabilityVersion === 'agent_pty_skills_v1')) || managedAgentTools.isAgentJobsCapability(validated.toolCapabilityVersion)) && validated.agentMode === 'build')) &&
      allowed.capabilities.agentTerminal === 'unsupported'
    ) {
      logGateDenial({ ctx, validated, stage: "model_capability", code: "MODEL_TERMINAL_UNSUPPORTED" });
      return res.status(statusFor("MODEL_TERMINAL_UNSUPPORTED")).json(errorBody("MODEL_TERMINAL_UNSUPPORTED"));
    }
    // Phase 17: verify_v1 preflight. agentTerminal=verified never implies
    // agentVerify. 'unsupported' always fails pre-dispatch with zero usage.
    // 'verified' passes. Unknown/absent probes only in test mode for
    // test-listed UIDs (controlled certification); production fails closed.
    // No provider usage, no protocol recovery in any rejection path.
    // Phase 18 certification: agent_v2 BUILD carries the verify bundle, so
    // the same mark policy applies — scoped to build mode since agent_v2
    // ASK/PLAN carry no verification tools.
    if (validated.toolCapabilityVersion === 'verify_v1' ||
      ((validated.toolCapabilityVersion === 'agent_v2' || validated.toolCapabilityVersion === 'agent_v3' || (validated.toolCapabilityVersion === 'agent_skills_v1' || (validated.toolCapabilityVersion === 'agent_mcp_skills_v1' || validated.toolCapabilityVersion === 'agent_pty_skills_v1')) || managedAgentTools.isAgentJobsCapability(validated.toolCapabilityVersion)) && validated.agentMode === 'build')) {
      const agentVerify = allowed.capabilities.agentVerify;
      if (agentVerify === 'unsupported') {
        logGateDenial({ ctx, validated, stage: "model_capability", code: "MODEL_VERIFY_UNSUPPORTED" });
        return res.status(statusFor("MODEL_VERIFY_UNSUPPORTED")).json(errorBody("MODEL_VERIFY_UNSUPPORTED"));
      }
      if (agentVerify !== 'verified') {
        const probeOk =
          fullCaps ||
          (agentCfg !== null && agentCfg.mode === 'test' &&
            Array.isArray(agentCfg.testUids) && agentCfg.testUids.includes(ctx.uid));
        if (!probeOk) {
          logGateDenial({ ctx, validated, stage: "model_capability", code: "MODEL_VERIFY_UNSUPPORTED" });
          return res.status(statusFor("MODEL_VERIFY_UNSUPPORTED")).json(errorBody("MODEL_VERIFY_UNSUPPORTED"));
        }
      }
    }
    let upstreamModelId;
    try {
      upstreamModelId = await effectiveModels.resolveUpstreamModelId(validated.modelKey);
    } catch (err) {
      const code = err && err.code === "MODEL_NOT_AVAILABLE" ? "MODEL_NOT_AVAILABLE" : "INTERNAL";
      return res.status(statusFor(code)).json(errorBody(code));
    }

    // School expiry must be enforced for ASK/PLAN as well as terminal BUILD;
    if (validated.freeModelOnly === true) {
      const approved = await approvedModelService.getApprovedModel(validated.modelKey).catch(() => null);
      if (!require('../services/freeCodingModel').isFreeCodingModel(approved) || approved.upstreamModelId !== upstreamModelId) return res.status(statusFor('MODEL_NOT_AVAILABLE')).json(errorBody('MODEL_NOT_AVAILABLE'));
      allowed = { ...allowed, pricing: { ...approved.pricing } };
    }
    // School expiry must be enforced for ASK/PLAN as well as terminal BUILD;
    // login admission is advisory and can be stale between provider turns.
    if (quotaMode === 'school_tokens') {
      try {
        const profile = await getUserProfile(ctx.uid);
        if (!profile) return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE'));
        const accountType = profile.accountType;
        if (accountType !== 'school') return res.status(403).json(errorBody('ACCOUNT_TYPE_UNSUPPORTED'));
        const school = profile.schoolId ? await getSchool(profile.schoolId) : null;
        if (!school) return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE'));
        if (school.accountType !== 'school') return res.status(403).json(errorBody('FORBIDDEN'));
        const decision = evaluateSubiCodeEntitlement({ accountType, userSubscription: profile.subscription || null, schoolSubscription: school.subscription || null });
        if (!decision.allowed) return res.status(statusFor(decision.code)).json(errorBody(decision.code));
      } catch (_) { return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE')); }
    }
    // Current individual entitlement is mandatory with enforcement ON or OFF.
    if (quotaMode === 'individual_credits') {
      try {
        const profile = await getUserProfile(ctx.uid);
        if (!profile) return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE'));
        if (profile.accountType !== 'individual') return res.status(403).json(errorBody('ACCOUNT_TYPE_UNSUPPORTED'));
        const decision = evaluateSubiCodeEntitlement({ accountType: profile.accountType, userSubscription: profile.subscription, schoolSubscription: null });
        if (!decision.allowed) return res.status(statusFor(decision.code)).json(errorBody(decision.code));
      } catch (_) { return res.status(503).json(errorBody('SUBI_ACCESS_UNAVAILABLE')); }
    }
    // Lazy credit-cycle recovery (individual ONLY): the cycle must exist
    // BEFORE reservation. Placed after model authorization (fail fast on
    // invalid models with zero side effects, preserving existing
    // MODEL_NOT_ALLOWED precedence) and before reservation/dispatch.
    // Schools never enter this block.
    // The recovered cycle is captured for shadow preflight below (shadow
    // accounting happens only AFTER the current cycle is ensured).
    let creditCycle = null;
    if (quotaMode === "individual_credits") {
      try {
        creditCycle = await individualCreditReady.ensureIndividualCreditReady({
          uid: ctx.uid,
          accountType: ctx.accountType,
        });
      } catch (err) {
        const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
        if (creditEnforcement) {
          // Preserve the pre-recovery unknown-user mapping (503).
          if (code === "SUBI_UNKNOWN_USER") {
            logGateDenial({ ctx, validated, stage: "credit_cycle", code: "SUBI_ACCESS_UNAVAILABLE" });
            return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
          }
          logGateDenial({ ctx, validated, stage: "credit_cycle", code });
          return res.status(statusFor(code)).json(errorBody(code));
        }
        // Readiness only while enforcement stays OFF: never block the
        // token-pathed turn on cycle maintenance (FX outage, expiry, etc.).
        try {
          logWarn("credit-cycle-ensure-best-effort", { code: safeCode(code) });
        } catch (_) {
          // Observability must never affect the turn.
        }
      }
    }

    let limit = null;
    // School path keeps monthlyLimitService authoritative. Individual credit
    // path skips token gates entirely (no MONTHLY_LIMIT_* for individuals).
    if (quotaMode === "school_tokens") {
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
        logGateDenial({ ctx, validated, stage: "monthly_limit", code: "MONTHLY_LIMIT_NOT_CONFIGURED" });
        return res.status(statusFor("MONTHLY_LIMIT_NOT_CONFIGURED")).json(errorBody("MONTHLY_LIMIT_NOT_CONFIGURED"));
      }
      if (limit.monthlyTokenLimit === 0) {
        logGateDenial({ ctx, validated, stage: "monthly_limit", code: "MONTHLY_LIMIT_EXCEEDED" });
        return res.status(statusFor("MONTHLY_LIMIT_EXCEEDED")).json(errorBody("MONTHLY_LIMIT_EXCEEDED"));
      }
    } else if (creditEnforcement) {
      // Wallet activation is a grant-time snapshot. Re-read the current paid
      // entitlement for every individual credit turn, including ASK/PLAN,
      // so expired subscribers cannot spend preserved purchased credits.
      try {
        const profile = await getUserProfile(ctx.uid);
        if (!profile) return res.status(503).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
        if (profile.accountType !== "individual") {
          return res.status(403).json(errorBody("ACCOUNT_TYPE_UNSUPPORTED"));
        }
        const entitlement = evaluateSubiCodeEntitlement({
          accountType: "individual", userSubscription: profile.subscription || null, schoolSubscription: null,
        });
        if (!entitlement.allowed) return res.status(403).json(errorBody(entitlement.code || "SUBI_CODE_REQUIRED"));
      } catch (_) {
        return res.status(503).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      // Credit fast-path: account must exist and subscription active.
      // Balance enforced at reserve time (estimate-based, fail closed).
      try {
        const acct = await individualCreditAccountService.getCreditAccount(ctx.uid);
        if (!acct || acct.subscriptionActive !== true) {
          logGateDenial({ ctx, validated, stage: "credit_account", code: "SUBI_PLAN_EXPIRED" });
          return res.status(403).json(errorBody("SUBI_PLAN_EXPIRED"));
        }
      } catch (_) {
        return res.status(statusFor("SUBI_ACCESS_UNAVAILABLE")).json(errorBody("SUBI_ACCESS_UNAVAILABLE"));
      }
      // Shadow logging when enabled for this UID (no enforcement change
      // beyond reserve). Fail-closed like the shadow gate: an empty
      // allowlist logs nobody.
      if (creditShadow && individualCreditFlags.isShadowEnabledForUid(creditFlags, ctx.uid)) {
        try {
          const { info } = require("../utils/structuredLogger");
          info("individual-credit-shadow", { requestIdHash: hashRequestId(turnRequestId), modelKey: validated.modelKey });
        } catch (_) { /* observability only */ }
      }
    }

    const systemPrompt = validated.nativeRequest ? require('../services/managedNativeAgent').systemPrompt(validated.agentMode) : agentValidator.agentSystemPrompt(
      validated.agentMode,
      validated.toolCapabilityVersion,
      validated.hostContext,
      validated.agentSkillsContext,
      validated.answerOnly
    );
    const openRouterMessages = validated.nativeRequest
      ? [{ role: 'system', content: systemPrompt }, ...validated.nativeRequest.messages]
      : managedAgentService.toOpenRouterMessages(validated.canonicalTurns, systemPrompt);
    // Estimator must include system prompt + exact server-owned tool schemas.
    const toolSchemaChars = Buffer.byteLength(
      JSON.stringify(
        validated.nativeRequest ? validated.nativeRequest.tools : validated.answerOnly ? [] : managedAgentTools.buildManagedAgentTools(
          validated.toolCapabilityVersion,
          validated.agentMode,
          validated.agentSkillsContext
        )
      ),
      "utf8"
    );
    const estimatorMessages = openRouterMessages.map((m) => ({
      content: typeof m.content === "string" ? m.content : JSON.stringify(m),
    }));
    let inputUpperBound;
    if (validated.canonicalTurns.some(turn => turn.images?.length)) {
      // Encoded upload bytes are not vision tokens. Reserve the complete
      // provider context ceiling, verified from canonical upstream metadata,
      // covering text, tools and all images. Admin-edited catalog display
      // metadata is never used as an accounting bound. Actual usage settles
      // the reservation; unknown usage remains conservatively chargeable.
      try {
        const { models } = await modelCatalog.fetchCatalog();
        if (res.destroyed || req.aborted) return;
        const model = models.find(item => item.upstreamModelId === upstreamModelId);
        if (!model?.capabilities?.inputModalities?.includes('image') ||
            !Number.isSafeInteger(model.contextLength) || model.contextLength <= 0) {
          return res.status(403).json(errorBody('IMAGE_INPUT_UNAVAILABLE'));
        }
        inputUpperBound = model.contextLength;
      } catch (err) {
        if (res.destroyed || req.aborted) return;
        const code = safeCode(err?.code || 'UPSTREAM_UNAVAILABLE');
        return res.status(statusFor(code)).json(errorBody(code));
      }
    } else {
      inputUpperBound = usageQuota.estimateInputUpperBound(estimatorMessages, systemPrompt.length + toolSchemaChars);
    }
    if (res.destroyed || req.aborted) return;

    const finalizeBaseParams = {
      reservationId: null,
      period: null,
      modelKey: validated.modelKey,
      requestId: turnRequestId,
    };
    // Individual shadow preflight (Stage 2 rollout telemetry): observational
    // ONLY — never mutates the wallet, never blocks the request. Runs only
    // for individual turns while real enforcement stays OFF, after the lazy
    // cycle above and after model authorization. Schools never enter (gated
    // inside shouldShadow before any store access). Gate/limit denials above
    // return before this point, so denied requests leave no shadow trace.
    // The existing non-enforced (token) reservation path below continues
    // unchanged.
    let shadowCtx = null;
    try {
      if (creditShadowService.shouldShadow({
        quotaMode,
        accountType: ctx.accountType,
        flags: creditFlags,
        uid: ctx.uid,
        enforcementEnabled: creditEnforcement,
      })) {
        let storedPricing = (allowed && allowed.pricing) || null;
        if (!storedPricing) {
          try {
            const reg = await approvedModelService.getApprovedModel(validated.modelKey);
            if (reg && reg.enabled === true) storedPricing = reg.pricing || null;
          } catch (_) {
            storedPricing = null;
          }
        }
        if (storedPricing) {
          const started = await creditShadowService.startShadow({
            uid: ctx.uid,
            requestId: turnRequestId,
            modelKey: validated.modelKey,
            storedPricing,
            inputUpperBound,
            maxOutputTokens: usageQuota.DEFAULT_MAX_OUTPUT_TOKENS,
            cycleId: creditCycle && typeof creditCycle.cycleId === "string" ? creditCycle.cycleId : null,
          });
          shadowCtx = started && started.record ? started : null;
        }
      }
    } catch (_) {
      shadowCtx = null;
      try {
        logWarn("credit_shadow.telemetry_failed", {
          requestIdHash: hashRequestId(turnRequestId),
          stage: "preflight",
        });
      } catch (_) {
        // Observability must never affect the turn.
      }
    }
    let reservation;
    let creditReservation = null;
    let creditPricingSnap = null;
    if (creditEnforcement) {
      // Individual credit reserve (no token reserve). Pricing pinned now.
      try {
        creditPricingSnap = pricingSnapshot.pinPricing({
          pricing: (allowed && allowed.pricing) || null,
          modelKey: validated.modelKey,
        });
      } catch (err) {
        return res.status(statusFor("MODEL_NOT_AVAILABLE")).json(errorBody("MODEL_NOT_AVAILABLE"));
      }
      const maxOut = usageQuota.DEFAULT_MAX_OUTPUT_TOKENS;
      let estimateMilli = 0;
      try {
        estimateMilli = creditMath.creditsMilliForUsage({
          inputTokens: inputUpperBound,
          outputTokens: maxOut,
          inputPricePerMillion: creditPricingSnap.inputPricePerMillion,
          outputPricePerMillion: creditPricingSnap.outputPricePerMillion,
        });
        // Free models still reserve min 1 credit to prevent empty-reserve loops;
        // commit settles exact (0 for empty, 1 min for real usage).
        if (!creditPricingSnap.isFree) estimateMilli = Math.max(1000, estimateMilli);
      } catch (_) {
        return res.status(statusFor("INTERNAL")).json(errorBody("INTERNAL"));
      }
      try {
        creditReservation = await individualCreditQuota.reserveCredits({
          uid: ctx.uid,
          requestId: turnRequestId,
          estimateMilli,
          pricing: (allowed && allowed.pricing) || null,
          modelKey: validated.modelKey,
        });
      } catch (err) {
        const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
        logGateDenial({ ctx, validated, stage: "credit_reservation", code });
        return res.status(statusFor(code)).json(errorBody(code));
      }
      reservation = {
        reservationId: creditReservation.reservationDocId,
        period: "credit-cycle",
        maxOutputTokens: maxOut,
        creditMilli: creditReservation.reservedMilli,
        creditPricing: creditPricingSnap,
      };
    } else {
      try {
        reservation = await requestAccounting.reserveUsage({
          uid: ctx.uid,
          schoolId: ctx.schoolId,
          role: ctx.role,
          accountType: ctx.accountType,
          modelKey: validated.modelKey,
          requestId: turnRequestId,
          inputUpperBound,
          defaultMaxOutputTokens: usageQuota.DEFAULT_MAX_OUTPUT_TOKENS,
        });
      } catch (err) {
        const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
        logGateDenial({ ctx, validated, stage: "reservation", code });
        return res.status(statusFor(code)).json(errorBody(code));
      }
    }
    finalizeBaseParams.reservationId = reservation.reservationId;
    finalizeBaseParams.period = reservation.period;

    res.setHeader("Content-Type", res.locals.nativeNonStreaming ? "application/json" : "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    let headersSent = false;
    const upstream = new AbortController();
    let streamDone = false;
    const onClientClose = () => {
      if (!streamDone && !res.writableEnded) {
        try {
          upstream.abort();
        } catch (_) {
          // best-effort
        }
      }
    };
    res.on("close", onClientClose);
    if (res.destroyed || req.aborted) upstream.abort();
    try {
      res.flushHeaders();
      headersSent = true;
    } catch (_) {
      if (creditEnforcement) {
        try {
          await individualCreditQuota.releaseCredits({ uid: ctx.uid, requestId: turnRequestId });
        } catch (_) { /* best-effort */ }
      } else {
        const preReleaseFinalizer = finalizeTurn({
          kind: "release",
          params: Object.assign({}, finalizeBaseParams),
        });
        const preReleaseResult = await preReleaseFinalizer();
        if (!preReleaseResult.accountingFinalized) {
          logWarn("managed-agent-preheaders-release-failed", {
            reservationId: finalizeBaseParams.reservationId,
            period: finalizeBaseParams.period,
          });
        }
      }
      if (shadowCtx) {
        // Headers never went out: provider dispatch never happened, so the
        // shadow settles as a zero-charge pre-dispatch failure (mirrors the
        // token-path release above).
        await finalizeShadowBestEffort({
          uid: ctx.uid,
          requestId: turnRequestId,
          usage: { inputTokens: 0, outputTokens: 0 },
          outcome: "pre_dispatch_failure",
          dispatched: false,
        });
      }
      try {
        res.removeListener("close", onClientClose);
      } catch (_) {
        // best-effort
      }
      return;
    }
    writeEvent(res, "start", { requestId: turnRequestId, modelKey: validated.modelKey, protocolVersion: 1 });
    let upstreamDispatched = false;
    let providerAccepted = false;
    const onBeforeProviderDispatch = async () => {
      if (creditEnforcement) {
        // Durable provider-risk boundary: later failures must charge, never
        // silently release. Throwing here aborts dispatch (fail-closed).
        // A concurrent cycle settlement may have terminalized the hold
        // (released/charged): never dispatch the provider on a dead hold.
        const marked = await individualCreditQuota.markCreditDispatched({ uid: ctx.uid, requestId: turnRequestId });
        if (marked && marked.alreadyTerminal === true) {
          const e = new Error("credit reservation already settled");
          e.code = "CREDIT_REQUEST_ALREADY_PROCESSED";
          throw e;
        }
        upstreamDispatched = true;
        return;
      }
      await requestAccounting.markDispatched({
        reservationId: reservation.reservationId,
        period: reservation.period,
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
      });
      upstreamDispatched = true;
    };
    const onProviderAccepted = async () => {
      providerAccepted = true;
      if (creditEnforcement) {
        // Provider definitely streaming: mark started so later unknown
        // outcomes charge conservatively instead of releasing.
        try {
          await individualCreditQuota.markCreditStarted({ uid: ctx.uid, requestId: turnRequestId });
        } catch (markErr) {
          // Accepted-but-unrecoverable: conservatively charge the held
          // reservation, then fail the turn (mirrors token
          // charge-accepted-unknown semantics).
          try {
            await individualCreditQuota.finalizeCreditUnknownUsage({ uid: ctx.uid, requestId: turnRequestId, modelKey: validated.modelKey });
          } catch (_) {
            // best-effort; the throw below still surfaces accounting failure
          }
          const err = new Error("accounting finalized after provider accept");
          err.code = "PROVIDER_UNAVAILABLE";
          err.providerAccepted = true;
          err.usage = { inputTokens: 0, outputTokens: 0 };
          throw err;
        }
        return;
      }
      try {
        await requestAccounting.markStarted({
          reservationId: reservation.reservationId,
          period: reservation.period,
        });
      } catch (markErr) {
        let chargeFinalizer;
        try {
          chargeFinalizer = finalizeTurn({
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
    let accountingFinalized = false;
    let accountingErrorCode = null;
    let freeLease = null;
    try {
      const usage = await managedAgentService.streamManagedAgent({
        upstreamModelId,
        openRouterMessages,
        maxOutputTokens: validated.nativeRequest?.max_tokens === undefined ? reservation.maxOutputTokens
          : Math.min(reservation.maxOutputTokens ?? validated.nativeRequest.max_tokens, validated.nativeRequest.max_tokens),
        onBeforeProviderDispatch: async () => {
          freeLease = await freeCapacity.acquireFreeCapacity({ upstreamModelId, attemptId: crypto.randomUUID() });
          await onBeforeProviderDispatch();
        },
        onProviderAccepted,
        toolCapabilityVersion: validated.toolCapabilityVersion,
        agentMode: validated.agentMode,
        agentSkillsContext: validated.agentSkillsContext,
        answerOnly: validated.answerOnly,
        nativeRequest: validated.nativeRequest,
        signal: upstream.signal,
        onEvent: async (ev) => {
          if (ev.type === "textDelta") writeEvent(res, "textDelta", { text: ev.text });
          else if (ev.type === "toolCallStart") {
            writeEvent(res, "toolCallStart", { providerCallId: ev.providerCallId, toolName: ev.toolName });
          } else if (ev.type === "toolCallArgsDelta") {
            writeEvent(res, "toolCallArgsDelta", { providerCallId: ev.providerCallId, partialArgs: ev.partialArgs });
          } else if (ev.type === "toolCallReady") {
            writeEvent(res, "toolCallReady", { providerCallId: ev.providerCallId, toolName: ev.toolName, argsText: ev.argsText });
          }
        },
      });
      const actual = cleanUsageNumbers(usage);
      if (creditEnforcement) {
        try {
          // Pinned pricing: commit reuses the reservation's stored snapshot
          // (no live pricing arg) so mid-request catalog moves never reprice.
          await individualCreditQuota.commitCredits({
            uid: ctx.uid,
            requestId: turnRequestId,
            actualInputTokens: actual.inputTokens,
            actualOutputTokens: actual.outputTokens,
            modelKey: validated.modelKey,
          });
          accountingFinalized = true;
        } catch (_) {
          accountingFinalized = false;
          accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
        }
      } else {
        const commitFinalizer = finalizeTurn({
          kind: "commit",
          params: Object.assign({}, finalizeBaseParams, {
            actualInputTokens: actual.inputTokens,
            actualOutputTokens: actual.outputTokens,
          }),
        });
        const r = await commitFinalizer();
        accountingFinalized = r.accountingFinalized;
        if (!accountingFinalized) accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
      }
      if (shadowCtx && !creditEnforcement) {
        // Shadow settles on the same aggregated provider totals the token
        // path committed. Never mutates the wallet, never affects the stream.
        await finalizeShadowBestEffort({
          uid: ctx.uid,
          requestId: turnRequestId,
          usage: actual,
          outcome: "provider_success",
          dispatched: upstreamDispatched,
        });
      }
      streamDone = true;
      const doneFinish = finishReasonForLog(usage && usage.finishReason);
      // Expose only provider-reported token counts, never accounting estimates,
      // price snapshots, credentials or upstream identifiers. Old clients ignore it.
      const reportedUsage = {};
      for (const field of ['inputTokens', 'outputTokens']) if (usage && usage.reportedUsage && Number.isSafeInteger(usage.reportedUsage[field]) && usage.reportedUsage[field] >= 0) reportedUsage[field] = usage.reportedUsage[field];
      writeEvent(res, "done", { requestId: turnRequestId, modelKey: validated.modelKey, fingerprint, ...(doneFinish ? { finishReason: doneFinish } : {}), ...(Object.keys(reportedUsage).length ? { usage: reportedUsage } : {}) });
      try {
        res.end();
      } catch (_) {
        // best-effort
      }
      // Accounting-mode diagnostic (observability only): which quota system
      // served this turn and whether shadow telemetry ran. school_token =
      // school monthly tokens; individual_legacy = pre-credit token path;
      // individual_shadow = legacy path + shadow telemetry;
      // individual_credit_enforced = real credit reservation. Uses the
      // route-owned accountingFinalized flag (never the router instance `r`;
      // a previous revision read `r.accountingFinalized`, which always
      // logged ACCOUNTING_UNAVAILABLE). Never affects the response.
      const accountingMode = quotaMode !== "individual_credits"
        ? "school_token"
        : creditEnforcement
          ? "individual_credit_enforced"
          : shadowCtx !== null ? "individual_shadow" : "individual_observation";
      logInfo("managed-agent-stream", {
        requestIdHash: hashRequestId(turnRequestId),
        quotaMode,
        accountingMode,
        creditEnforcement: creditEnforcement === true,
        creditShadow: shadowCtx !== null,
        period: reservation.period,
        reservationId: reservation.reservationId,
        modelKey: validated.modelKey,
        stage: "stream",
        code: accountingFinalized ? "OK" : "ACCOUNTING_UNAVAILABLE",
        providerAccepted,
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
      if (creditEnforcement) {
        // Individual credit failure paths (no token docs).
        try {
          if (code === "DISPATCH_ABORTED" || !upstreamDispatched) {
            await individualCreditQuota.releaseCredits({ uid: ctx.uid, requestId: turnRequestId });
            accountingFinalized = true;
          } else if (code === "PROVIDER_AUTH_FAILED" || code === "PROVIDER_RATE_LIMITED") {
            await individualCreditQuota.releaseCredits({ uid: ctx.uid, requestId: turnRequestId });
            accountingFinalized = true;
          } else if (code === "ACCOUNTING_UNAVAILABLE") {
            accountingFinalized = false;
            accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
          } else if (usageQuota.classifyFinalization({ upstreamDispatched, usage: partial }) === "commit") {
            // Pinned pricing: no live pricing arg (uses reservation snapshot).
            await individualCreditQuota.commitCredits({
              uid: ctx.uid,
              requestId: turnRequestId,
              actualInputTokens: partial.inputTokens,
              actualOutputTokens: partial.outputTokens,
              modelKey: validated.modelKey,
              finalState: terminalState,
            });
            accountingFinalized = true;
          } else {
            // Unknown post-dispatch: conservative bounded charge of the held
            // reservation (never throws for insufficient funds, never
            // refunds provider-risk money, always audited). Pinned pricing
            // is irrelevant here: no new usage is priced, the held amount
            // stays spent.
            await individualCreditQuota.finalizeCreditUnknownUsage({
              uid: ctx.uid,
              requestId: turnRequestId,
              modelKey: validated.modelKey,
            });
            accountingFinalized = true;
          }
        } catch (_) {
          accountingFinalized = false;
          accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
        }
      } else if (code === "DISPATCH_ABORTED") {
        pickedFinalizer = finalizeTurn({ kind: "fail", params: Object.assign({}, finalizeBaseParams) });
      } else if (!upstreamDispatched) {
        pickedFinalizer = finalizeTurn({ kind: "release", params: Object.assign({}, finalizeBaseParams) });
      } else if (code === "PROVIDER_AUTH_FAILED" || code === "PROVIDER_RATE_LIMITED") {
        pickedFinalizer = finalizeTurn({ kind: "fail", params: Object.assign({}, finalizeBaseParams) });
      } else if (code === "ACCOUNTING_UNAVAILABLE") {
        accountingFinalized = false;
        accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
        logError("managed-agent-error", {
          requestIdHash: hashRequestId(turnRequestId),
          period: reservation.period,
          reservationId: reservation.reservationId,
          modelKey: validated.modelKey,
          stage: "markstarted-finalize-failed",
          code: "ACCOUNTING_UNAVAILABLE",
          providerAccepted: true,
        });
      } else if (usageQuota.classifyFinalization({ upstreamDispatched, usage: partial }) === "commit") {
        pickedFinalizer = finalizeTurn({
          kind: "commit",
          params: Object.assign({}, finalizeBaseParams, {
            actualInputTokens: partial.inputTokens,
            actualOutputTokens: partial.outputTokens,
            finalState: terminalState,
          }),
        });
      } else {
        pickedFinalizer = finalizeTurn({
          kind: "charge",
          params: Object.assign({}, finalizeBaseParams, { finalState: terminalState }),
        });
      }
      if (!creditEnforcement && pickedFinalizer) {
        const r = await pickedFinalizer();
        accountingFinalized = r.accountingFinalized;
        if (!accountingFinalized) accountingErrorCode = "ACCOUNTING_UNAVAILABLE";
      }
      if (shadowCtx && !creditEnforcement) {
        // Shadow failure semantics mirror the credit-enforcement failure
        // paths: no dispatch means no provider risk (zero projection);
        // definite provider rejections and cancellations settle on observed
        // partial usage; dispatched-but-unknown settles conservatively on
        // the held estimate inside finalizeShadow. Never blocks the error
        // response below.
        let shadowOutcome = "unknown_post_dispatch";
        let shadowUsage = partial;
        if (code === "DISPATCH_ABORTED" || !upstreamDispatched) {
          shadowOutcome = "pre_dispatch_failure";
          shadowUsage = { inputTokens: 0, outputTokens: 0 };
        } else if (code === "CANCELLED") {
          shadowOutcome = "cancelled";
        } else if (code === "PROVIDER_AUTH_FAILED" || code === "PROVIDER_RATE_LIMITED") {
          shadowOutcome = "provider_error";
        } else if (usageQuota.classifyFinalization({ upstreamDispatched, usage: partial }) === "commit") {
          shadowOutcome = "provider_error";
        }
        await finalizeShadowBestEffort({
          uid: ctx.uid,
          requestId: turnRequestId,
          usage: shadowUsage,
          outcome: shadowOutcome,
          dispatched: upstreamDispatched,
        });
      }
      // Safe terminal-failure diagnostic (Phase 13 hotfix): structured
      // fields only — normalized code, upstream HTTP status number,
      // provider-risk flags, hashed request id. Never prompt/completion
      // text, tokens beyond aggregate-free flags, keys, tokens, or bodies.
      try {
        const httpStatus =
          err && typeof err.httpStatus === "number" && Number.isSafeInteger(err.httpStatus)
            ? err.httpStatus
            : 0;
        logWarn("managed-agent-terminal-failure", {
          requestIdHash: hashRequestId(turnRequestId),
          period: reservation.period,
          reservationId: reservation.reservationId,
          modelKey: validated.modelKey,
          stage: upstreamDispatched ? "provider" : "pre_dispatch",
          code: safeCode(code),
          providerAccepted,
          httpStatus,
          accountingFinalized,
          failureKind: ['provider_event_error', 'response_limit', 'tool_arguments_limit', 'missing_tool_id', 'invalid_tool_call', 'empty_stream'].includes(err?.failureKind) ? err.failureKind : 'other',
        });
      } catch (_) {
        // Observability must never affect accounting or response.
      }
      if (code === "CANCELLED" || code === "DISPATCH_ABORTED") {
        try {
          res.end();
        } catch (_) {
          // best-effort
        }
        return;
      }
      if (accountingErrorCode === "ACCOUNTING_UNAVAILABLE") {
        sendError(res, headersSent, "ACCOUNTING_UNAVAILABLE");
        return;
      }
      if (code === "AI_NOT_CONFIGURED" || code === "SECRET_UNAVAILABLE") {
        sendError(res, headersSent, "AI_CONNECTION_UNAVAILABLE");
        return;
      }
      const httpStatus = err && typeof err.httpStatus === "number" ? err.httpStatus : undefined;
      sendError(res, headersSent, code, httpStatus, err && err.retryAfterMs);
    } finally {
      try { await freeCapacity.releaseFreeCapacity(freeLease); } catch (_) { logWarn('managed-free-capacity-release', { code: 'CAPACITY_RELEASE_PENDING' }); }
      try {
        res.removeListener("close", onClientClose);
      } catch (_) {
        // best-effort
      }
    }
  });

  return r;
}

module.exports = { managedAgentRouter: router };
