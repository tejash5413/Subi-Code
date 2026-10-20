// functions-subi/src/app.js
// Two isolated Express apps (Phase 1A): subiManagedApi (future
// student/teacher runtime) and subiAdminApi (future superadmin management).
// No provider secrets, no chat/quota/usage logic yet.

const express = require("express");
const { subiCors } = require("./middleware/cors");
const { requireAuth } = require("./middleware/auth");
const { requireSuperAdmin } = require("./middleware/superadmin");
const { managedStatusRouter, adminStatusRouter } = require("./routes/status");
const { adminAiConnectionRouter } = require("./routes/adminAiConnection");
const { managedAccessRouter } = require("./routes/managedAccess");
const { managedSubiCodeRouter } = require("./routes/managedSubiCode");
const { adminAccessRouter } = require("./routes/adminAccess");
const { adminUsersRouter } = require("./routes/adminUsers");
const { managedCatalogRouter } = require("./routes/managedCatalog");
const { managedModelsRouter } = require("./routes/managedModels");
const { managedLimitsRouter } = require("./routes/managedLimits");
const { managedUsageRouter } = require("./routes/managedUsage");
const { managedChatRouter } = require("./routes/managedChat");
const { managedAgentRouter } = require("./routes/managedAgent");
const { managedSearchRouter } = require("./routes/managedSearch");
const { adminModelsRouter } = require("./routes/adminModels");
const { adminModelPoliciesRouter } = require("./routes/adminModelPolicies");
const { adminUsageRouter } = require("./routes/adminUsage");
const { adminReadinessRouter } = require("./routes/adminReadiness");
const { adminManagedChatConfigRouter } = require("./routes/adminManagedChatConfig");
const { adminManagedAgentConfigRouter } = require("./routes/adminManagedAgentConfig");
const { adminLimitsRouter } = require("./routes/adminLimits");
const { adminIndividualCreditsRouter } = require("./routes/adminIndividualCredits");
const { billingRouter } = require("./routes/billing");

// Tight body limit for credential routes only. Mounted BEFORE the general
// parser: Express runs middleware in order, so requests to this path are
// parsed here (req._body set) and the later general parser skips them.
const CREDENTIAL_JSON_LIMIT = "4kb";

// Note: requireAuth is not mounted on the Phase-1 public /status route.
// Future managed routes mount behind requireAuth({ managedOnly: true }).
function buildManagedApp() {
  const app = express();
  app.use(subiCors);
  app.use(express.json({ limit: "256kb" }));
  app.use("/", managedStatusRouter());
  // Login-admission status + managed model list. Each router applies its
  // own route-scoped requireAuth({ managedOnly: true }); no app-level
  // managedOnly chain may exist here, or it would reject superadmins for
  // every path (including /admin/model-catalog below).
  app.use("/", managedAccessRouter());
  app.use("/", managedSubiCodeRouter());
  app.use("/", managedModelsRouter());
  app.use("/", managedLimitsRouter());
  app.use("/", managedUsageRouter());
  // Superadmin catalogue on the MANAGED runtime (secretAccessor lives here).
  // Plain requireAuth (not managedOnly): superadmins are not students/teachers.
  app.use("/", requireAuth(), requireSuperAdmin, managedCatalogRouter());
  return app;
}

// Chat-only JSON body cap (Phase 8, TEXT ONLY). Calculation: at most 20
// messages x 20k chars with a 100k aggregate budget; 512kb covers worst-case
// multibyte text plus JSON framing with headroom. Config endpoints stay at
// 256kb. Images/base64 are NOT supported in Phase 8 (rejected by the
// validator), so no 20MB parser exists anywhere.
const CHAT_JSON_LIMIT = "512kb";

// Dedicated streaming gateway app (Phase 8, local-only — see index.js).
// Mounted on its own function so timeout/memory/body-limit/future-IAM stay
// independent of the lightweight config APIs.
function buildManagedChatApp() {
  const app = express();
  app.use(subiCors);
  app.use("/chat", express.json({ limit: CHAT_JSON_LIMIT }));
  // Route applies its own requireAuth({ managedOnly: true }).
  app.use("/", managedChatRouter());
  // Safe error surface for the chat function: oversized bodies become
  // REQUEST_TOO_LARGE (never 413 HTML), everything else INTERNAL.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.status === 413 || err.type === "entity.too.large")) {
      return res.status(413).json({ error: { code: "REQUEST_TOO_LARGE" } });
    }
    return res.status(err && err.status ? err.status : 500).json({ error: { code: "INTERNAL" } });
  });
  return app;
}

// Dedicated agent gateway app (Phase 13, local-only — see index.js).
// Separate function so quota/streaming/timeout stay independent of chat.
// Agent JSON body cap: canonical transcript (24 turns x 20k + tool calls)
// plus framing; 768kb covers worst-case multibyte + JSON with headroom.
// Bounded image_v1 data (4 MiB decoded / ~5.4 MiB base64) plus transcript.
// This limit applies only to agent turns, never config/chat/search endpoints.
const AGENT_JSON_LIMIT = "8mb";

function buildManagedAgentApp() {
  const app = express();
  app.use(subiCors);
  app.use("/agent/turn", express.json({ limit: AGENT_JSON_LIMIT }));
  app.use("/agent/chat/completions", express.json({ limit: AGENT_JSON_LIMIT }));
  app.use("/agent/search", express.json({ limit: "4kb" }));
  // Routes apply their own requireAuth({ managedOnly: true }). Search rides
  // the same subiManagedAgentApi function (no new deploy target).
  app.use("/", managedAgentRouter());
  app.use("/", managedSearchRouter());
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.status === 413 || err.type === "entity.too.large")) {
      return res.status(413).json({ error: { code: "REQUEST_TOO_LARGE" } });
    }
    return res.status(err && err.status ? err.status : 500).json({ error: { code: "INTERNAL" } });
  });
  return app;
}

function buildAdminApp() {
  const app = express();
  // CORS first: preflight OPTIONS must succeed before auth.
  app.use(subiCors);
  // Credential routes: small body cap + auth + superadmin, before general parser.
  app.use(
    "/",
    express.json({ limit: CREDENTIAL_JSON_LIMIT }),
    requireAuth(),
    requireSuperAdmin,
    adminAiConnectionRouter()
  );
  app.use(express.json({ limit: "256kb" }));
  // Admin status requires a valid token AND trusted superadmin role.
  app.use("/", requireAuth(), requireSuperAdmin, adminStatusRouter());
  // Global + School access management (Phase 3A).
  app.use("/", requireAuth(), requireSuperAdmin, adminAccessRouter());
  // Individual user access management (Phase 3B).
  app.use("/", requireAuth(), requireSuperAdmin, adminUsersRouter());
  // Approved-model administration (Phase 4).
  app.use("/", requireAuth(), requireSuperAdmin, adminModelsRouter());
  // School + individual model assignment (Model Redesign).
  app.use("/", requireAuth(), requireSuperAdmin, adminModelPoliciesRouter());
  // Token-usage reporting (Usage tab; counters only, never message text).
  app.use("/", requireAuth(), requireSuperAdmin, adminUsageRouter());
  // Model-policy cutover readiness (read-only; never mutates policy).
  app.use("/", requireAuth(), requireSuperAdmin, adminReadinessRouter());
  // Managed-chat operational gate (mode + test UIDs only; never secrets).
  app.use("/", requireAuth(), requireSuperAdmin, adminManagedChatConfigRouter());
  // Managed-agent operational gate (mode + test UIDs only; never secrets).
  app.use("/", requireAuth(), requireSuperAdmin, adminManagedAgentConfigRouter());
  // Per-user monthly token limits (Phase 5).
  app.use("/", requireAuth(), requireSuperAdmin, adminLimitsRouter());
  // Individual credit accounts/flags (read-only admin; schools never appear).
  app.use("/", requireAuth(), requireSuperAdmin, adminIndividualCreditsRouter());
  // Safe error surface: body-parser errors (e.g. 413) become coded JSON,
  // never stacks or HTML.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.status === 413 || err.type === "entity.too.large")) {
      return res.status(413).json({ error: { code: "INVALID_REQUEST" } });
    }
    return res.status(err && err.status ? err.status : 500).json({ error: { code: "INTERNAL" } });
  });
  // Future admin routes mount behind the same chain.
  return app;
}

// Individual SUBI billing app (quote/order/status + Cashfree webhook).
// Quote + order creation gate on billingEnabled (OFF by default). The webhook
// settles already-created SUBI orders regardless of the flag.
function buildBillingApp() {
  const app = express();
  app.use(subiCors);
  // Webhook route parses its own raw body (HMAC input); general parser
  // covers quote/order/status only and must not pre-consume the webhook.
  app.use("/subi/billing/webhook", express.raw({ type: "application/json", limit: "256kb" }));
  app.use(express.json({ limit: "256kb" }));
  app.use("/", billingRouter());
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.status === 413 || err.type === "entity.too.large")) {
      return res.status(413).json({ error: { code: "INVALID_REQUEST" } });
    }
    return res.status(err && err.status ? err.status : 500).json({ error: { code: "INTERNAL" } });
  });
  return app;
}

module.exports = { buildManagedApp, buildAdminApp, buildManagedChatApp, buildManagedAgentApp, buildBillingApp };
