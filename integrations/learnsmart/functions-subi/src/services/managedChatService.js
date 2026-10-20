// functions-subi/src/services/managedChatService.js
// Isolated managed OpenRouter streaming (Phase 8, TEXT ONLY).
//
// BOUNDARY: this is the ONLY backend location allowed to reference the
// OpenRouter chat URL. It implements NO policy: no Access rules, no model
// assignment, no monthly-limit logic, no usage enforcement, no website AI.
// Callers pass already-authorized primitives
// ({requestId, upstreamModelId, messages}) plus injectable
// {keyResolver, fetchImpl, signal, onDelta}.
//
// The managed key lives in a local Buffer only and is zero-filled in
// `finally`. Prompts/completions/usage are never logged, persisted, or
// returned except as normalized delta text via onDelta and aggregate
// token counts in the internal result (consumed by Phase-9 quota
// reconciliation; never client-visible).
//
// Phase 9A.1: accepts onBeforeProviderDispatch (awaited after key
// resolution, before fetch — the quota layer's reserved→dispatched
// transition; a throw means fetch NEVER runs), maxOutputTokens
// (server-reserved output budget, always sent as provider max_tokens) and
// onProviderAccepted (awaited after a successful upstream response, before
// body consumption — the quota layer's dispatched→started transition).
// Abnormal-path errors carry internal-only
// { providerAccepted, usage } so the route can reconcile exactly without
// trusting client counts.
//
// DI: streamManagedChat(deps) accepts {keyResolver, fetchImpl} for fakes.

const aiConnectionService = require("./aiConnectionService");
const { parseProviderRetryAfterMs, parseSharedFreeResetAtMs } = require('../utils/providerRetryTiming');

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const CONNECT_TIMEOUT_MS = 30_000;
// Hard stream ceiling below the 540s chat-function maximum.
const STREAM_MAX_MS = 500_000;
// Memory bound on one response; exceeded → safe abort, never unbounded.
// 65,536 chars = 16x the 4096-token provider output budget: generous for
// any legitimate Unicode expansion, while bounding memory. A pathological
// response beyond it becomes a retryable provider error with exact partial
// usage committed — never silent truncation, never quota corruption.
const MAX_RESPONSE_CHARS = 65_536;

function defaultDeps() {
  return {
    keyResolver: () => aiConnectionService.resolveActiveManagedKey(),
    fetchImpl: fetch,
  };
}

function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isAbortError(err) {
  return !!err && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

// Incremental SSE frame parser over a fetch body reader. Emits {text}
// for OpenRouter delta chunks and captures {inputTokens, outputTokens}
// when the provider includes a usage chunk. Throws CANCELLED on abort,
// PROVIDER_UNAVAILABLE on empty/malformed streams. Every throw carries
// internal-only `usage` (partial counts observed so far) so callers can
// reconcile quota exactly; never trust client counts.
async function parseUpstreamStream(body, { signal, onDelta, isCancelled }) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let chars = 0;
  let sawDone = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const frames = [];
  const attachUsage = (err) => {
    if (err && typeof err === "object") {
      err.providerAccepted = true;
      err.usage = { inputTokens, outputTokens };
    }
    return err;
  };
  try {
    for (;;) {
      if (signal && signal.aborted) throw coded("cancelled", "CANCELLED");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        frames.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      for (const frame of frames.splice(0)) {
        const dataLines = [];
        for (const line of frame.split("\n")) {
          const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (clean.startsWith(":")) continue; // keep-alive/comment
          if (clean.startsWith("data:")) {
            const v = clean.slice(5);
            dataLines.push(v.startsWith(" ") ? v.slice(1) : v);
          }
        }
        if (dataLines.length === 0) continue;
        const data = dataLines.join("\n").trim();
        if (!data) continue;
        if (data === "[DONE]") {
          sawDone = true;
          continue;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch (_) {
          continue; // framing noise; never fail the stream on it
        }
        if (!chunk || typeof chunk !== "object") continue;
        const usage = chunk.usage;
        if (usage && typeof usage === "object") {
          if (Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0) {
            inputTokens = usage.prompt_tokens;
          }
          if (Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0) {
            outputTokens = usage.completion_tokens;
          }
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const delta = choices.length > 0 && choices[0] && typeof choices[0] === "object"
          ? choices[0].delta
          : null;
        const text = delta && typeof delta.content === "string" ? delta.content : "";
        if (text) {
          chars += text.length;
          if (chars > MAX_RESPONSE_CHARS) {
            throw coded("response too large", "PROVIDER_UNAVAILABLE");
          }
          await onDelta(text);
        }
      }
      if (isCancelled && isCancelled()) throw attachUsage(coded("cancelled", "CANCELLED"));
    }
  } catch (err) {
    throw attachUsage(err);
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      // Stream already closed; nothing to do.
    }
    try {
      reader.releaseLock();
    } catch (_) {
      // Already released; nothing to do.
    }
  }
  const postUsage = { inputTokens, outputTokens };
  if (signal && signal.aborted) {
    const err = coded("cancelled", "CANCELLED");
    err.providerAccepted = true;
    err.usage = postUsage;
    throw err;
  }
  if (chars === 0 && !sawDone) {
    const err = coded("empty upstream stream", "PROVIDER_UNAVAILABLE");
    err.providerAccepted = true;
    err.usage = postUsage;
    throw err;
  }
  return { inputTokens, outputTokens };
}

function markPreAccept(err) {
  if (err && typeof err === "object" && err.providerAccepted === undefined) {
    err.providerAccepted = false;
  }
  return err;
}

async function streamManagedChat({ requestId, upstreamModelId, messages, onDelta, signal, keyResolver, fetchImpl, maxOutputTokens, onBeforeProviderDispatch, onProviderAccepted }) {
  const d = { ...defaultDeps(), keyResolver: keyResolver || defaultDeps().keyResolver, fetchImpl: fetchImpl || defaultDeps().fetchImpl };
  if (typeof requestId !== "string" || !requestId) throw markPreAccept(coded("invalid request", "INVALID_REQUEST"));
  if (typeof upstreamModelId !== "string" || !upstreamModelId) throw markPreAccept(coded("invalid model", "INTERNAL"));
  if (!Array.isArray(messages) || messages.length === 0) throw markPreAccept(coded("invalid messages", "INVALID_REQUEST"));
  if (typeof onDelta !== "function") throw markPreAccept(coded("invalid handler", "INTERNAL"));
  if (maxOutputTokens !== undefined) {
    if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw markPreAccept(coded("invalid output budget", "INTERNAL"));
    }
  }

  let key;
  try {
    key = await d.keyResolver();
  } catch (err) {
    if (err && (err.code === "AI_NOT_CONFIGURED" || err.code === "SECRET_UNAVAILABLE")) throw markPreAccept(err);
    throw markPreAccept(coded("secret unavailable", "SECRET_UNAVAILABLE"));
  }

  const upstream = new AbortController();
  const onCallerAbort = () => {
    try {
      upstream.abort();
    } catch (_) {
      // best-effort only
    }
  };
  if (signal) {
    if (signal.aborted) {
      if (Buffer.isBuffer(key)) key.fill(0);
      throw markPreAccept(coded("cancelled", "CANCELLED"));
    }
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const connectTimer = setTimeout(() => upstream.abort(), CONNECT_TIMEOUT_MS);
  let ceilingHit = false;
  const maxTimer = setTimeout(() => {
    ceilingHit = true;
    upstream.abort();
  }, STREAM_MAX_MS);
  const callerAborted = () => !!(signal && signal.aborted);
  try {
    // Durable dispatch boundary (Phase 9A.1): quota layer persists
    // DISPATCHED BEFORE any network byte may leave. Key resolution already
    // succeeded above, so only quota-store failure can stop us here — and
    // that leaves the reservation safely RESERVED (releasable, zero
    // charge). Inside try/finally so timer cleanup always runs.
    if (typeof onBeforeProviderDispatch === "function") {
      await onBeforeProviderDispatch();
    }
    // Synchronous abort re-check: no await runs between here and fetchImpl,
    // so an already-aborted signal proves the request never left.
    // Terminalize as cancelled with zero charge (failDispatched in route).
    if (signal && signal.aborted) {
      const dispatchAbort = coded("cancelled before dispatch", "DISPATCH_ABORTED");
      dispatchAbort.providerAccepted = false;
      throw dispatchAbort;
    }
    let res;
    try {
      res = await d.fetchImpl(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${key.toString("utf8")}`,
        },
        body: JSON.stringify({
          model: upstreamModelId,
          messages,
          stream: true,
          ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
          stream_options: { include_usage: true },
        }),
        signal: upstream.signal,
      });
    } catch (err) {
      if (isAbortError(err) || upstream.signal.aborted) {
        if (callerAborted()) throw markPreAccept(coded("cancelled", "CANCELLED"));
        throw markPreAccept(coded("upstream timeout", "TIMEOUT"));
      }
      throw markPreAccept(coded("upstream unavailable", "PROVIDER_UNAVAILABLE"));
    } finally {
      clearTimeout(connectTimer);
    }
    if (res.status === 401 || res.status === 403) {
      throw markPreAccept(coded("upstream auth failed", "PROVIDER_AUTH_FAILED"));
    }
    if (res.status === 429) {
      const err = markPreAccept(coded('upstream rate limited', 'PROVIDER_RATE_LIMITED'));
      err.retryAfterMs = parseProviderRetryAfterMs(res.headers);
      err.sharedFreeResetAtMs = parseSharedFreeResetAtMs(res.headers);
      if (err.sharedFreeResetAtMs) err.retryAfterMs = Math.max(err.retryAfterMs || 0, err.sharedFreeResetAtMs - Date.now());
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = markPreAccept(coded('upstream unavailable', 'PROVIDER_UNAVAILABLE'));
      err.retryAfterMs = parseProviderRetryAfterMs(res.headers);
      throw err;
    }
    if (!res.body || typeof res.body.getReader !== "function") {
      throw markPreAccept(coded("invalid upstream body", "PROVIDER_UNAVAILABLE"));
    }
    // Provider accepted: quota layer transitions dispatched → started here,
    // before any body byte is consumed. A failing callback aborts the
    // stream and propagates RAW: the durable DISPATCHED record (not this
    // throw) decides accounting, so a markStarted outage can never silently
    // release. The route keys finalization off its own dispatch tracking.
    if (typeof onProviderAccepted === "function") {
      try {
        await onProviderAccepted();
      } catch (err) {
        try {
          upstream.abort();
        } catch (_) {
          // best-effort only
        }
        throw err;
      }
    }
    const cancelled = () => callerAborted() || ceilingHit;
    try {
      return await parseUpstreamStream(res.body, {
        signal: upstream.signal,
        onDelta,
        isCancelled: cancelled,
      });
    } catch (err) {
      if ((err && err.code === "CANCELLED") || upstream.signal.aborted) {
        if (callerAborted()) {
          const cancelledErr = coded("cancelled", "CANCELLED");
          cancelledErr.providerAccepted = true;
          cancelledErr.usage = (err && err.usage) || { inputTokens: 0, outputTokens: 0 };
          throw cancelledErr;
        }
        const timeoutErr = coded("stream timeout", "TIMEOUT");
        timeoutErr.providerAccepted = true;
        timeoutErr.usage = (err && err.usage) || { inputTokens: 0, outputTokens: 0 };
        throw timeoutErr;
      }
      throw err;
    }
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(maxTimer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
    try {
      if (Buffer.isBuffer(key)) key.fill(0);
    } catch (_) {
      // best-effort wipe only
    }
  }
}

module.exports = {
  streamManagedChat,
  CHAT_URL,
  CONNECT_TIMEOUT_MS,
  STREAM_MAX_MS,
  MAX_RESPONSE_CHARS,
};
