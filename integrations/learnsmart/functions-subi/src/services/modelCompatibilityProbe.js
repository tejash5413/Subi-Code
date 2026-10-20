// functions-subi/src/services/modelCompatibilityProbe.js
// Controlled SUBI compatibility probe (admin-triggered only).
//
// Reuses the existing provider infrastructure (managedAgentService.
// streamManagedAgent): same managed key resolution, same OpenRouter chat
// URL, same SSE parsing as production turns. This module contains NO
// provider URL, NO key handling, NO quota logic — all injected/called.
//
// What a probe checks per kind (two short turns, bounded output):
//   turn 1: model must emit a valid tool call (proves tool-calling works).
//   turn 2: model must complete with text after a synthetic tool result
//           (proves it follows the tool workflow to completion).
// Outcomes per kind:
//   "verified"    — both turns succeeded deterministically.
//   "unsupported" — model deterministically failed (no/invalid tool call,
//                   no completion). Never from transient errors.
//   "unknown"     — inconclusive (provider/auth/rate-limit/network/timeout,
//                   unknown model). Marks are left untouched.
// Vision is NOT probed (no image round-trip); inputModalities metadata
// remains the vision source. Price is NEVER an input (all tiers probed).
//
// Evidence is booleans/counts/error codes only — never prompts, completions,
// keys, or upstream identifiers.

const managedAgentService = require("./managedAgentService");
const { resolveUpstreamModelId } = require("./effectiveModelService");

const PROBE_MAX_OUTPUT_TOKENS = 256;
const PROBE_TURN_TIMEOUT_MS = 90_000;
const PROBE_KINDS = new Set(["tool", "terminal", "verify"]);

// kind -> provider bundle exercised (valid validator combinations).
const KIND_BUNDLES = {
  tool: { toolCapabilityVersion: "read_v1", agentMode: "ask" },
  terminal: { toolCapabilityVersion: "terminal_v1", agentMode: "build" },
  verify: { toolCapabilityVersion: "verify_v1", agentMode: "build" },
};

const PROBE_TURN1_TEXT =
  "Probe instruction: call one of the provided tools now with the exact JSON argument " +
  '{"probe": 42}. Do not reply with text yet; emit exactly one tool call.';
const PROBE_TURN2_TEXT =
  'The tool returned {"probe": 42, "ok": true}. Reply with exactly: DONE';

// Provider/transient failures stay inconclusive — never certified either way.
const INCONCLUSIVE_CODES = new Set([
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "MODEL_NOT_AVAILABLE",
  "TIMEOUT",
  "CANCELLED",
  "DISPATCH_ABORTED",
  "SECRET_UNAVAILABLE",
  "AI_NOT_CONFIGURED",
  "INTERNAL",
]);

function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function cleanKinds(value) {
  const list = Array.isArray(value) && value.length > 0 ? value : ["tool", "terminal", "verify"];
  const out = [];
  for (const k of list) {
    const kind = String(k || "").trim().toLowerCase();
    if (!PROBE_KINDS.has(kind)) throw coded(`unknown probe kind: ${kind}`, "INVALID_REQUEST");
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}

function withTimeout(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TURN_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
    },
  };
}

async function runTurn({ upstreamModelId, messages, bundle, agentService, keyResolver, fetchImpl, signal }) {
  const calls = [];
  let textParts = [];
  const guard = withTimeout(signal);
  try {
    await agentService.streamManagedAgent({
      upstreamModelId,
      openRouterMessages: messages,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      toolCapabilityVersion: bundle.toolCapabilityVersion,
      agentMode: bundle.agentMode,
      ...(keyResolver ? { keyResolver } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      signal: guard.signal,
      onEvent: async (ev) => {
        if (!ev || typeof ev !== "object") return;
        if (ev.type === "toolCallReady") calls.push({ toolName: ev.toolName, argsText: ev.argsText });
        else if (ev.type === "textDelta" && typeof ev.text === "string") textParts.push(ev.text);
      },
    });
  } finally {
    guard.done();
  }
  return { calls, text: textParts.join("") };
}

function argsValid(argsText) {
  if (typeof argsText !== "string" || argsText.length === 0) return false;
  try {
    JSON.parse(argsText);
    return true;
  } catch (_) {
    return false;
  }
}

async function probeKind({ upstreamModelId, kind, agentService, keyResolver, fetchImpl, signal }) {
  const bundle = KIND_BUNDLES[kind];
  const evidence = {
    turn1ToolCalls: 0,
    turn1ArgsValid: false,
    turn2Completed: false,
    errorCode: null,
  };
  try {
    const turn1 = await runTurn({
      upstreamModelId,
      messages: [{ role: "user", content: PROBE_TURN1_TEXT }],
      bundle,
      agentService,
      keyResolver,
      fetchImpl,
      signal,
    });
    evidence.turn1ToolCalls = turn1.calls.length;
    const valid = turn1.calls.some((c) => argsValid(c.argsText));
    evidence.turn1ArgsValid = valid;
    if (!valid) return { status: "unsupported", evidence };
    const turn2 = await runTurn({
      upstreamModelId,
      messages: [
        { role: "user", content: PROBE_TURN1_TEXT },
        { role: "user", content: PROBE_TURN2_TEXT },
      ],
      bundle,
      agentService,
      keyResolver,
      fetchImpl,
      signal,
    });
    evidence.turn2Completed = /done/i.test(turn2.text);
    if (!evidence.turn2Completed) return { status: "unsupported", evidence };
    return { status: "verified", evidence };
  } catch (err) {
    evidence.errorCode = (err && err.code) || "UNKNOWN";
    // Inconclusive stays unknown regardless of the underlying code: only a
    // deterministic model failure may mark unsupported.
    return { status: "unknown", evidence };
  }
}

/**
 * Probe one registry model. Never persists marks (see setModelCertification
 * for the explicit admin persist step).
 */
async function probeModelCompatibility({ modelKey, kinds }, deps) {
  const d = { ...(deps || {}) };
  const id = String(modelKey || "").trim().slice(0, 128);
  if (!id || !/^mdl_[A-Za-z0-9-]+$/.test(id)) throw coded("invalid modelKey", "INVALID_REQUEST");
  const kindsList = cleanKinds(kinds);
  const agentService = d.agentService || managedAgentService;
  let upstreamModelId;
  try {
    upstreamModelId = await resolveUpstreamModelId(id, d.store ? { store: d.store } : undefined);
  } catch (err) {
    return {
      modelKey: id,
      probedAtMs: Date.now(),
      tool: { status: "unknown", evidence: { turn1ToolCalls: 0, turn1ArgsValid: false, turn2Completed: false, errorCode: (err && err.code) || "MODEL_NOT_AVAILABLE" } },
    };
  }
  const out = { modelKey: id, probedAtMs: Date.now() };
  for (const kind of kindsList) {
    const key = kind === "tool" ? "tool" : kind;
    out[key] = await probeKind({
      upstreamModelId,
      kind,
      agentService,
      keyResolver: d.keyResolver,
      fetchImpl: d.fetchImpl,
      signal: d.signal,
    });
  }
  return out;
}

module.exports = {
  probeModelCompatibility,
  PROBE_KINDS: [...PROBE_KINDS],
  KIND_BUNDLES,
  INCONCLUSIVE_CODES,
};
