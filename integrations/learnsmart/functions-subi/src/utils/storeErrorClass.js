// functions-subi/src/utils/storeErrorClass.js
// Safe categorical classification of store-layer failure codes (Phase 9B.2C).
//
// Purpose: preserve the failure CATEGORY for diagnostics without logging
// anything sensitive. Inspects ONLY error.code (string or gRPC numeric).
// Never reads error.message, stack, or any other field; never logs the raw
// error object. Unknown shapes collapse to UNKNOWN (fail closed).
//
// Supported input formats (only these; everything else is UNKNOWN):
//   - Firestore string codes, any case/separator:
//     "UNAVAILABLE", "unavailable", "deadline-exceeded", "DEADLINE_EXCEEDED"
//   - gRPC numeric codes as used by Firestore client errors:
//     14 UNAVAILABLE, 10 ABORTED, 4 DEADLINE_EXCEEDED,
//     9 FAILED_PRECONDITION, 8 RESOURCE_EXHAUSTED, 13 INTERNAL, 2 UNKNOWN

const GRPC_NUMERIC_CLASSES = {
  2: "UNKNOWN",
  4: "DEADLINE_EXCEEDED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
};

const STRING_CLASSES = new Set([
  "UNAVAILABLE",
  "ABORTED",
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
  "UNKNOWN",
]);

function classifyStoreErrorCode(error) {
  let candidate;
  if (typeof error === "number") {
    candidate = error;
  } else if (
    error !== null &&
    typeof error === "object" &&
    (typeof error.code === "string" || typeof error.code === "number")
  ) {
    candidate = error.code;
  } else {
    return "UNKNOWN";
  }
  if (typeof candidate === "number") {
    if (!Number.isSafeInteger(candidate)) return "UNKNOWN";
    return Object.prototype.hasOwnProperty.call(GRPC_NUMERIC_CLASSES, candidate)
      ? GRPC_NUMERIC_CLASSES[candidate]
      : "UNKNOWN";
  }
  const normalized = candidate.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return STRING_CLASSES.has(normalized) ? normalized : "UNKNOWN";
}

module.exports = { classifyStoreErrorCode };
