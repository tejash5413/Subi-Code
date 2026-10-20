// functions-subi/src/services/auditService.js
// Safe audit writer (Phase 2A).
//
// BOUNDARY: may import ONLY subiDb. Never learnsmartDb, never Secret
// Manager. Records metadata only — never key material, tokens, payloads,
// request bodies, or upstream responses.

const { subiDb } = require("../db");

const CONNECTION_ACTIONS = new Set([
  "ai_connection.configured",
  "ai_connection.replaced",
  "ai_connection.removed",
  "ai_connection.rollback",
]);

// Phase 3A access-control actions. Safe metadata only (booleans/ids).
const ACCESS_ACTIONS = new Set([
  "subi_access.enabled",
  "subi_access.disabled",
  "school_role_access.changed",
  // Phase 3B individual overrides.
  "user_access.enabled",
  "user_access.disabled",
  "user_access.inherit",
]);

// Phase 4 approved-model actions. Metadata only (modelKey/booleans/names).
// Model Redesign assignment actions. ModelKeys are safe internal config
// identifiers — never provider secrets or upstream key material.
const MODEL_ACTIONS = new Set([
  "model.approved",
  "model.updated",
  "model.enabled",
  "model.disabled",
  "model.removed",
  // Explicit compatibility certification (terminal/verify marks). Metadata
  // only: before/after enum states, never probe prompts or upstream ids.
  "model.certified",
  "school_models.updated",
  "user_models.custom",
  "user_models.inherit",
]);

// Phase 5 per-user monthly token-limit actions. Numeric policy values only.
const LIMIT_ACTIONS = new Set([
  "school_monthly_limit.updated",
  "user_monthly_limit.custom",
  "user_monthly_limit.inherit",
]);

// Phase 9A.1 managed-chat operational gate. Mode + test UIDs only — never
// secrets, prompts, or provider material.
const CHAT_CONFIG_ACTIONS = new Set(["managed_chat_config.updated"]);

// Managed-agent operational gate. Safe mode, test UIDs and capability flags.
const AGENT_CONFIG_ACTIONS = new Set(["managed_agent_config.updated"]);

function cleanUid(value) {
  return String(value || "").slice(0, 128);
}

function cleanMeta(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 256);
  if (Array.isArray(value)) return value.slice(0, 20).map(cleanMeta);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 20)) {
      out[String(k).slice(0, 64)] = cleanMeta(v);
    }
    return out;
  }
  return null;
}

async function logAudit({ adminUid, action, target, result, failureCode, before, after }, dbOverride) {
  if (!CONNECTION_ACTIONS.has(action) && !ACCESS_ACTIONS.has(action) && !MODEL_ACTIONS.has(action) && !LIMIT_ACTIONS.has(action) && !CHAT_CONFIG_ACTIONS.has(action) && !AGENT_CONFIG_ACTIONS.has(action)) {
    throw new Error("auditService: unknown action");
  }
  const db = dbOverride || subiDb;
  const doc = {
    createdAt: new Date(),
    adminUid: cleanUid(adminUid),
    action,
    target: target && typeof target === "object" ? cleanMeta(target) : {},
    result: result === "failure" ? "failure" : "success",
  };
  if (doc.result === "failure" && failureCode) {
    doc.failureCode = String(failureCode).slice(0, 64);
  }
  if (before !== undefined) doc.before = cleanMeta(before);
  if (after !== undefined) doc.after = cleanMeta(after);
  const ref = await db.collection("auditLogs").add(doc);
  return { id: ref.id };
}

module.exports = { logAudit, CONNECTION_ACTIONS, ACCESS_ACTIONS, MODEL_ACTIONS, LIMIT_ACTIONS, CHAT_CONFIG_ACTIONS, AGENT_CONFIG_ACTIONS };
