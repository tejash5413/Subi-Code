// functions-subi/src/utils/errorOrigin.js
// Safe error-origin classification (Phase 9B.2F).
//
// Answers ONE question: was this error intentionally constructed by SUBI
// domain code, or did it arrive from the store/SDK layer? Returns only the
// categorical vocabulary below — never codes, messages, stacks, paths,
// identities, or document contents.
//
// Design:
//   - SUBI domain errors carry the non-behavioral boolean marker
//     `isSubiDomainError === true`, set at construction in the quota helpers
//     (invalidRequest/coded) and the dispatch inline domain throws. The
//     marker is authoritative: presence means domain, full stop.
//   - WITHOUT the marker, classification is by code SHAPE only. Numeric
//     gRPC codes and recognized Firestore/store code names mean store.
//     Exact SUBI-owned code strings WITHOUT the marker are ambiguous by
//     design (any layer could use the same words) and collapse to unknown.
//   - Anything else (missing code, foreign shapes) is unknown. Fail closed.
//
// The classifier inspects ONLY error.code (plus the marker). It never reads
// error.message, stack, or any other field, and never stringifies errors.

// Exact SUBI-owned code strings. Only meaningful WITH the marker; without
// it they are ambiguous and MUST NOT imply domain (see classifyErrorOrigin).
const DOMAIN_CODES = new Set([
  "INVALID_REQUEST",
  "REQUEST_ALREADY_PROCESSED",
  "REQUEST_IN_PROGRESS",
  "INTERNAL",
]);

// Recognized Firestore/gRPC/store code names (any case/separator).
// INTERNAL is intentionally ABSENT here: without the marker it is
// ambiguous (raw store vs unmarked domain) and stays unknown.
const STORE_CODE_NAMES = new Set([
  "UNAVAILABLE",
  "ABORTED",
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "RESOURCE_EXHAUSTED",
  "UNKNOWN",
  "CANCELLED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "DATA_LOSS",
  "UNAUTHENTICATED",
]);

// gRPC numeric codes are SDK-shaped by construction; SUBI domain helpers
// always use string codes. Any safe integer in the gRPC range means store.
const GRPC_MIN = 0;
const GRPC_MAX = 16;

function normalizeCodeName(value) {
  return String(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function classifyErrorOrigin(error) {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    let marked = false;
    try {
      marked = error.isSubiDomainError === true;
    } catch (_) {
      marked = false;
    }
    if (marked) return "domain";
    const code = error.code;
    if (typeof code === "number") {
      if (Number.isSafeInteger(code) && code >= GRPC_MIN && code <= GRPC_MAX) return "store";
      return "unknown";
    }
    if (typeof code === "string") {
      const normalized = normalizeCodeName(code);
      if (STORE_CODE_NAMES.has(normalized)) return "store";
      return "unknown";
    }
    return "unknown";
  }
  if (typeof error === "number") {
    if (Number.isSafeInteger(error) && error >= GRPC_MIN && error <= GRPC_MAX) return "store";
  }
  return "unknown";
}

// Second safe dimension, valid ONLY when classifyErrorOrigin already said
// domain (the code is then guaranteed SUBI-made). Returns null otherwise.
function classifyDomainCode(error) {
  if (classifyErrorOrigin(error) !== "domain") return null;
  const code = error && error.code;
  if (typeof code !== "string") return "OTHER_DOMAIN";
  const normalized = normalizeCodeName(code);
  if (normalized === "INVALID_REQUEST") return "INVALID_REQUEST";
  if (normalized === "REQUEST_ALREADY_PROCESSED") return "REQUEST_ALREADY_PROCESSED";
  if (normalized === "INTERNAL") return "INTERNAL";
  return "OTHER_DOMAIN";
}

// Safe shape of error.code. Never returns or logs the value itself.
function classifyErrorCodeType(error) {
  if (error === null || error === undefined) return "missing";
  if (typeof error !== "object" && typeof error !== "function") return "missing";
  let hasCode = false;
  let code;
  try {
    hasCode = "code" in error;
    code = hasCode ? error.code : undefined;
  } catch (_) {
    return "missing";
  }
  if (code === null || code === undefined) return "missing";
  if (typeof code === "number") return "number";
  if (typeof code === "string") return "string";
  return "other";
}

// Safe error-kind category. Uses instanceof for built-ins and an exact
// allowlist of SDK constructor names (derived from the installed
// firebase-admin 12 / @google-cloud/firestore 7 / google-gax 4 tree:
// GoogleError, FirebaseError, FirebaseAppError, FirebaseFirestoreError).
// The name is only ever COMPARED, never emitted.
function classifyErrorKind(error) {
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof ReferenceError) return "reference_error";
  if (error instanceof SyntaxError) return "syntax_error";
  let name = "";
  try {
    name =
      error !== null && (typeof error === "object" || typeof error === "function")
        ? String(error.name || "")
        : "";
  } catch (_) {
    name = "";
  }
  if (name === "GoogleError") return "google_error";
  if (name === "FirebaseError" || name === "FirebaseAppError" || name === "FirebaseFirestoreError") {
    return "firebase_error";
  }
  if (error instanceof Error) return "generic_error";
  return "unknown";
}

module.exports = { classifyErrorOrigin, classifyDomainCode, classifyErrorCodeType, classifyErrorKind };
