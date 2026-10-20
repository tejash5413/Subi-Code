// functions-subi/src/routes/managedAccess.js
// Login-admission status for LearnSmart students/teachers (Phase 3A).
// Independent of AI Connection: never touches secretService,
// aiConnectionService, OpenRouter, or SUBI_OPENROUTER_API_KEY.

const express = require("express");
const accessService = require("../services/accessService");
const agentConfig = require("../services/managedAgentConfigService");
const creditFlags = require("../services/individualCreditFlags");
const { resolveQuotaMode } = require('../services/quotaModeService');
const {
  getUserProfile,
  getSchool,
} = require("../services/learnsmartDirectoryService");
const {
  evaluateSubiCodeEntitlement,
} = require("../services/subiCodeEntitlementService");
const { requireAuth } = require("../middleware/auth");
const { info: logAccessInfo, hashRequestId } = require("../utils/structuredLogger");

// Safe bootstrap diagnostics (observability only): hashed UID, coarse
// account/role, outcome code, elapsed time. Never UID/email/token/payload.
function instrumentAccessDiagnostics(req, res, ctx, startedMs) {
  try {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const b = body && typeof body === "object" ? body : {};
        logAccessInfo("managed-access-status", {
          uidHash: hashRequestId(ctx.uid),
          accountType: typeof ctx.accountType === "string" ? ctx.accountType.slice(0, 32) : null,
          role: typeof ctx.role === "string" ? ctx.role.slice(0, 16) : null,
          allowed: b.allowed === true,
          code: (typeof b.code === "string" && b.code) ||
            (b.error && typeof b.error.code === "string" && b.error.code) || null,
          elapsedMs: Date.now() - startedMs,
        });
      } catch (_) {
        // Observability must never affect the response.
      }
      return origJson(body);
    };
  } catch (_) {
    // Observability must never affect the request.
  }
}

function router() {
  const r = express.Router();

  // managedOnly lives on the route (not app.use("/")) so sibling chains —
  // e.g. the superadmin catalogue route — are never gated by it.
  r.get("/managed/access-status", requireAuth({ managedOnly: true }), async (req, res) => {
    const ctx = req.subi || {};
    const startedMs = Date.now();
    instrumentAccessDiagnostics(req, res, ctx, startedMs);
    // Safe context is derived only from the authenticated directory.
    const context = ctx.accountType === 'school' || ctx.accountType === 'individual'
      ? { accountType: ctx.accountType, quotaMode: resolveQuotaMode(ctx) } : {};
    const json = res.json.bind(res);
    res.json = body => json({ ...context, ...body });
    try {
      const result = await accessService.resolveSubiAccess({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        accountType: ctx.accountType,
      });
      if (result.allowed) {
        // Subi Code entitlement (authoritative):
        // - school: expiry ONLY (Subi Code included by default).
        // - individual: BOTH Subi Code activated AND plan not expired.
        try {
          const profile = await getUserProfile(ctx.uid);
          const accountType = (profile && profile.accountType) || ctx.accountType;
          if (accountType !== "individual" && accountType !== "school") {
            return res.json({ allowed: false, code: "ACCOUNT_TYPE_UNSUPPORTED" });
          }
          let schoolSubscription = null;
          if (accountType === "school") {
            const schoolId = (profile && profile.schoolId) || ctx.schoolId;
            if (schoolId) {
              try {
                const school = await getSchool(schoolId);
                schoolSubscription = (school && school.subscription) || null;
              } catch (_) {
                schoolSubscription = null;
              }
            }
          }
          const entitlement = evaluateSubiCodeEntitlement({
            accountType,
            userSubscription: (profile && profile.subscription) || null,
            schoolSubscription,
          });
          if (!entitlement.allowed) {
            return res.json({ allowed: false, code: entitlement.code || "SUBI_CODE_REQUIRED" });
          }
        } catch (_) {
          // Fail closed when entitlement cannot be evaluated.
          return res.json({ allowed: false, code: "SUBI_ACCESS_UNAVAILABLE" });
        }
        // File capability is advisory for composer preflight only; the
        // managed-agent route rechecks the same server config every turn.
        let agentFile = "none";
        let agentTerminal = "none";
        let agentAvailable = false;
        let agentJobs;
        let agentCoordination;
        try {
          const config = await agentConfig.getManagedAgentConfig();
          agentAvailable = agentConfig.evaluateAgentAvailability(config, ctx.uid).allowed === true;
          if (agentAvailable) {
            // Mirror the existing /agent/turn authority; this response never
            // changes configuration, entitlement, access policy or quotas.
            const flags = await creditFlags.getIndividualCreditFlags().catch(() => null);
            // Admission stays valid while production individual execution is
            // unavailable; /agent/turn rechecks this same enforcement gate.
            if (config.mode === 'enabled' && ctx.accountType === 'individual' && flags?.enforcementEnabled !== true) {
              agentAvailable = false;
            } else {
              agentJobs = agentConfig.evaluateJobsCapability(config, ctx.uid);
              agentCoordination = agentConfig.evaluateCoordinationCapability(config, ctx.uid);
              const fullCapabilities = flags?.fullAgentCapabilitiesEnabled === true;
              agentFile = fullCapabilities ? 'build' : agentConfig.evaluateFileCapability(config, ctx.uid);
              agentTerminal = config.terminalEnabled === true
                ? fullCapabilities ? 'terminal' : agentConfig.evaluateTerminalCapability(config, ctx.uid)
                : 'none';
            }
          }
        } catch (_) {
          // Fail closed without blocking otherwise-valid managed access.
        }
        const permissionPolicy = await accessService.getManagedPermissionPolicy({
          accountType: ctx.accountType, schoolId: ctx.schoolId, role: ctx.role,
        });
        return res.json({ allowed: true, permissionPolicy, agentAvailable, ...(agentFile !== 'none' ? { agentFile } : {}), ...(agentTerminal === 'terminal' ? { agentTerminal } : {}), agentImage: 'image_v1', ...(agentAvailable ? { agentMcp: 'mcp_v1' } : {}), ...(agentAvailable && agentTerminal === 'terminal' ? { agentPty: 'pty_v1' } : {}), toolCapabilities: ['agent_skills_v1'], ...(agentJobs ? { agentJobs } : {}), ...(agentCoordination ? { agentCoordination } : {}) });
      }
      return res.json({ allowed: false, code: "SUBI_ACCESS_DISABLED" });
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(503).json({ allowed: false, code: "SUBI_ACCESS_UNAVAILABLE" });
      }
      return res.status(500).json({ error: { code: "INTERNAL" } });
    }
  });

  return r;
}

module.exports = { managedAccessRouter: router };
