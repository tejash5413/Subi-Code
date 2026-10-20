// functions-subi/src/services/managedChatValidator.js
// Strict validator for POST /chat (Phase 8, TEXT ONLY).
//
// Accepts ONLY { requestId, modelKey, messages }. Unknown top-level or
// per-message fields are rejected: the client carries zero authority
// (no uid/school/role/access/limits/provider/upstream/system).

const MODEL_KEY_RE = /^mdl_[A-Za-z0-9-]+$/;
const MAX_KEY_LEN = 128;
const MAX_REQUEST_ID_LEN = 64;
const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 20000;
const MAX_AGGREGATE_CHARS = 100000;
const ALLOWED_TOP_FIELDS = new Set(["requestId", "modelKey", "messages"]);
const ALLOWED_MSG_FIELDS = new Set(["role", "content"]);
const ALLOWED_ROLES = new Set(["user", "assistant"]);

function invalidRequest(message) {
  const err = new Error(message);
  err.code = "INVALID_REQUEST";
  throw err;
}

function tooLarge(message) {
  const err = new Error(message);
  err.code = "REQUEST_TOO_LARGE";
  throw err;
}

function checkNoUnknown(obj, allowed, what) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) invalidRequest(`unknown ${what} field`);
  }
}

// Returns { requestId, modelKey, messages } with clean copies.
// Throws INVALID_REQUEST (shape/authority) or REQUEST_TOO_LARGE (budgets).
function validateChatBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalidRequest("invalid request body");
  }
  checkNoUnknown(body, ALLOWED_TOP_FIELDS, "request");

  const requestId = body.requestId;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LEN) {
    invalidRequest("invalid requestId");
  }

  const rawKey = typeof body.modelKey === "string" ? body.modelKey.trim().slice(0, MAX_KEY_LEN) : "";
  if (!rawKey || !MODEL_KEY_RE.test(rawKey)) {
    invalidRequest("invalid modelKey");
  }

  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > MAX_MESSAGES) {
    invalidRequest("invalid messages");
  }
  const messages = [];
  let aggregate = 0;
  for (const m of rawMessages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      invalidRequest("invalid message");
    }
    checkNoUnknown(m, ALLOWED_MSG_FIELDS, "message");
    if (!ALLOWED_ROLES.has(m.role)) {
      // role:"system" and anything else is rejected: the server owns
      // system content and the client carries no authority.
      invalidRequest("invalid message role");
    }
    if (typeof m.content !== "string" || m.content.length === 0 || m.content.length > MAX_CONTENT_CHARS) {
      invalidRequest("invalid message content");
    }
    aggregate += m.content.length;
    if (aggregate > MAX_AGGREGATE_CHARS) {
      tooLarge("message history exceeds aggregate budget");
    }
    messages.push({ role: m.role, content: m.content });
  }
  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.content.trim()) {
    invalidRequest("final message must be user text");
  }
  return { requestId, modelKey: rawKey, messages };
}

module.exports = {
  validateChatBody,
  MODEL_KEY_RE,
  MAX_KEY_LEN,
  MAX_REQUEST_ID_LEN,
  MAX_MESSAGES,
  MAX_CONTENT_CHARS,
  MAX_AGGREGATE_CHARS,
};
