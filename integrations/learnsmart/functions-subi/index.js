// functions-subi/index.js
// SUBI Managed AI — isolated Functions entrypoint (Phase 1A foundation).
//
// Deliberately independent from ../functions: no imports of chatHandler,
// allapi/apiV2, OPENROUTER logic, or website quota code.
//
// Exports (Firebase Functions v2, asia-south1 to match project convention):
// - subiManagedApi: future student/teacher runtime (public /status for now)
// - subiAdminApi:   future superadmin management (auth + superadmin /status)
// Phase 1 binds no provider secrets.
// Phase 2 will introduce the separate SUBI_OPENROUTER_API_KEY.

const { onRequest } = require("firebase-functions/v2/https");
const { buildManagedApp, buildAdminApp, buildManagedChatApp, buildManagedAgentApp, buildBillingApp } = require("./src/app");

const REGION = "asia-south1";

// Future least-privilege runtime identities (Phase 2B creates them; no
// deploy or IAM change in Phase 2A).
const MANAGED_SERVICE_ACCOUNT =
  "subi-managed-runtime@learnsmart-c2a7e.iam.gserviceaccount.com";
const ADMIN_SERVICE_ACCOUNT =
  "subi-admin-runtime@learnsmart-c2a7e.iam.gserviceaccount.com";
// Dedicated chat runtime (Phase 9B): least-privilege identity for usage
// writes + managed-key reads. Config/catalogue APIs stay on their own SAs.
const MANAGED_CHAT_SERVICE_ACCOUNT =
  "subi-managed-chat-runtime@learnsmart-c2a7e.iam.gserviceaccount.com";

exports.subiManagedApi = onRequest(
  {
    region: REGION,
    memory: "256MiB",
    timeoutSeconds: 60,
    serviceAccount: MANAGED_SERVICE_ACCOUNT,
  },
  buildManagedApp()
);

exports.subiAdminApi = onRequest(
  {
    region: REGION,
    memory: "256MiB",
    timeoutSeconds: 60,
    serviceAccount: ADMIN_SERVICE_ACCOUNT,
  },
  buildAdminApp()
);

// Phase 9B: dedicated managed-chat streaming gateway on its own runtime
// identity. Server chat gate defaults to disabled (missing config), so the
// endpoint is inert until a Superadmin explicitly enables test/enabled mode
// in a later phase. The extension keeps Send disabled independently.
exports.subiManagedChatApi = onRequest(
  {
    region: REGION,
    memory: "512MiB",
    timeoutSeconds: 540,
    serviceAccount: MANAGED_CHAT_SERVICE_ACCOUNT,
  },
  buildManagedChatApp()
);

// Phase 13: dedicated managed-AGENT streaming gateway. Reuses the chat
// runtime identity (least-privilege: usage writes + managed-key reads) so no
// IAM change is required. Server agent gate defaults to disabled; the
// extension MANAGED_AGENT_ENABLED gate is independently enforced.
exports.subiManagedAgentApi = onRequest(
  {
    region: REGION,
    memory: "512MiB",
    timeoutSeconds: 540,
    serviceAccount: MANAGED_CHAT_SERVICE_ACCOUNT,
  },
  buildManagedAgentApp()
);

// Individual SUBI billing (quote/order/status + Cashfree webhook). Quote and
// order creation stay gated on billingEnabled (OFF by default); the webhook
// settles already-created SUBI orders regardless. Cashfree credentials arrive
// via function secrets (same names as the default codebase); the service also
// accepts DI overrides for fakes. NOTE: the billing runtime identity needs
// datastore access to BOTH the `subi` database and `(default)` users docs
// (subscription activation) — grant at deploy time.
exports.subiBillingApi = onRequest(
  {
    region: REGION,
    memory: "256MiB",
    timeoutSeconds: 120,
    serviceAccount: ADMIN_SERVICE_ACCOUNT,
    secrets: ["CASHFREE_CLIENT_ID", "CASHFREE_CLIENT_SECRET"],
  },
  buildBillingApp()
);
