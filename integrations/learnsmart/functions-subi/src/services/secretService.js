// functions-subi/src/services/secretService.js
// Sole owner of ALL Google Secret Manager access (Phase 2A).
// No route or other service may instantiate SecretManagerServiceClient.
//
// BOUNDARY: Secret Manager only. Never touches Firestore (neither
// learnsmartDb nor subiDb). Never logs or returns key material to HTTP.
//
// IAM design (Phase 2B):
// - subiManagedApi SA: secretAccessor on SUBI_OPENROUTER_API_KEY (read only)
// - subiAdminApi SA:    secretVersionAdder on SUBI_OPENROUTER_API_KEY (add only)
// Deliberately NO destroy/disable/enable/delete methods in Phase 2.

const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "learnsmart-c2a7e";

// Allowlisted secret: the ONE managed credential. Never accept a secret
// name/id from request input.
const MANAGED_SECRET_ID = "SUBI_OPENROUTER_API_KEY";

function secretPath() {
  return `projects/${PROJECT_ID}/secrets/${MANAGED_SECRET_ID}`;
}

function versionPath(version) {
  const v = String(version || "").trim();
  if (!/^\d+$/.test(v)) throw new Error("secretService: invalid version");
  return `${secretPath()}/versions/${v}`;
}

// Injectable client for unit tests (fakes). Production uses ADC via the
// function's attached service account.
let clientOverride = null;
function setClientForTests(client) {
  clientOverride = client || null;
}
function client() {
  if (clientOverride) return clientOverride;
  return new SecretManagerServiceClient();
}

// Adds a new version holding the validated transient key.
// Returns SAFE metadata only: { version: "N" }.
async function addVersion(transientKey) {
  if (typeof transientKey !== "string" || !transientKey) {
    throw new Error("secretService.addVersion: invalid key");
  }
  const [response] = await client().addSecretVersion({
    parent: secretPath(),
    payload: { data: Buffer.from(transientKey, "utf8") },
  });
  const name = String((response && response.name) || "");
  const version = name.split("/").pop();
  if (!/^\d+$/.test(version || "")) {
    throw new Error("secretService.addVersion: unexpected response");
  }
  return { version };
}

// Reads an EXACT numeric version. Returns the payload Buffer to the trusted
// backend caller ONLY (resolveActiveManagedKey). Never serialize to HTTP.
async function accessVersion(version) {
  const [response] = await client().accessSecretVersion({
    name: versionPath(version),
  });
  const data = response && response.payload && response.payload.data;
  if (!data) throw new Error("secretService.accessVersion: empty payload");
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

module.exports = {
  MANAGED_SECRET_ID,
  secretPath,
  addVersion,
  accessVersion,
  setClientForTests,
};
