// functions-subi/src/services/managedAgentService.js
// Isolated managed OpenRouter agent streaming (Phase 13, TOOL-CAPABLE).
//
// BOUNDARY: this is the ONLY backend location besides managedChatService.js
// allowed to reference the OpenRouter chat URL. It implements NO policy: no
// Access rules, no model assignment, no monthly-limit logic, no usage
// enforcement, no website AI. Callers pass already-authorized primitives
// ({upstreamModelId, openRouterMessages, maxOutputTokens}) plus injectable
// {keyResolver, fetchImpl, signal, onEvent}.
//
// The managed key lives in a local Buffer only and is zero-filled in
// `finally`. Prompts/completions/usage are never logged, persisted, or
// returned except as normalized agent events via onEvent and aggregate
// token counts in the internal result.
//
// DI: streamManagedAgent(deps) accepts {keyResolver, fetchImpl} for fakes.

const aiConnectionService = require("./aiConnectionService");
const { parseProviderRetryAfterMs, parseSharedFreeResetAtMs } = require("../utils/providerRetryTiming");
const { buildManagedAgentTools, isFileToolCapability, isCoordinationCapability } = require("./managedAgentTools");

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const CONNECT_TIMEOUT_MS = 30_000;
const STREAM_MAX_MS = 500_000;
const MAX_RESPONSE_CHARS = 65_536;

function defaultDeps() {
  return {
    keyResolver: () => aiConnectionService.resolveActiveManagedKey(),
    fetchImpl: fetch,
  };
}

function coded(message, code, failureKind) {
  const err = new Error(message);
  err.code = code;
  if (failureKind) err.failureKind = failureKind;
  return err;
}

function isAbortError(err) {
  return !!err && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

// Assemble streamed tool calls keyed by index: supports split id, late id,
// split name, split JSON args, interleaved text, multiple calls, separate
// finish_reason. Emits normalized events via onEvent:
//   textDelta { text }
//   toolCallStart { providerCallId, toolName }
//   toolCallArgsDelta { providerCallId, partialArgs }
//   toolCallReady { providerCallId, toolName, argsText }
// finish reason + usage captured in result.
async function parseUpstreamAgentStream(body, { signal, onEvent, isCancelled, maxToolArgsChars = 8000, validateToolCall }) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let chars = 0;
  let sawDone = false;
  let sawUsable = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const reportedUsage = {};
  let finishReason = null;
  const frames = [];
  // index -> { id, name, argsText, started }
  const calls = new Map();
  const attachUsage = (err) => {
    if (err && typeof err === "object") {
      err.providerAccepted = true;
      err.usage = { inputTokens, outputTokens };
    }
    return err;
  };
  async function emit(ev) {
    sawUsable = true;
    await onEvent(ev);
  }
  try {
    for (;;) {
      if (signal && signal.aborted) throw coded("cancelled", "CANCELLED");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      // SSE permits CRLF. Normalize the accumulated buffer so a CR/LF
      // pair split across network reads still forms the same frame boundary.
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        frames.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      for (const frame of frames.splice(0)) {
        const dataLines = [];
        let eventName = "";
        for (const line of frame.split("\n")) {
          const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (clean.startsWith(":")) continue;
          if (clean.startsWith("event:")) {
            eventName = clean.slice(6).trim();
            continue;
          }
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
          continue;
        }
        if (!chunk || typeof chunk !== "object") continue;
        if (chunk.error && typeof chunk.error === "object") {
          // Only a numeric explicit rejection before any usable output is a
          // rate-limit retry. Partial/ambiguous streams must not be replayed.
          const rateLimited = chunk.error.code === 429 && !sawUsable && calls.size === 0;
          const err = coded("upstream provider error", rateLimited ? "PROVIDER_RATE_LIMITED" : "PROVIDER_UNAVAILABLE", "provider_event_error");
          if (Number.isSafeInteger(chunk.error.code) && chunk.error.code >= 400 && chunk.error.code <= 599) err.httpStatus = chunk.error.code;
          err.providerAccepted = true;
          err.usage = { inputTokens, outputTokens };
          throw err;
        }
        const usage = chunk.usage;
        if (usage && typeof usage === "object") {
          if (Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0) {
            inputTokens = usage.prompt_tokens;
            reportedUsage.inputTokens = inputTokens;
          }
          if (Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0) {
            outputTokens = usage.completion_tokens;
            reportedUsage.outputTokens = outputTokens;
          }
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const choice = choices.length > 0 && choices[0] && typeof choices[0] === "object" ? choices[0] : null;
        if (!choice) continue;
        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : null;
        // Phase 13.5: some providers/models emit the final message object
        // instead of (or after) deltas. Normalize it through the same path
        // so a valid response is never mistaken for an empty stream.
        const message = choice.message && typeof choice.message === "object" ? choice.message : null;
        const textParts = [];
        const pushContent = (content) => {
          if (typeof content === "string" && content) {
            textParts.push(content);
          } else if (Array.isArray(content)) {
            // OpenAI-compatible content parts: user-visible text only.
            // Reasoning/image/refusal parts are ignored, never surfaced.
            for (const part of content) {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text) {
                textParts.push(part.text);
              }
            }
          }
        };
        if (delta) {
          pushContent(delta.content);
        }
        if (message && textParts.length === 0) {
          pushContent(message.content);
        }
        for (const piece of textParts) {
          chars += piece.length;
          if (chars > MAX_RESPONSE_CHARS) {
            throw coded("response too large", "PROVIDER_UNAVAILABLE", "response_limit");
          }
          await emit({ type: "textDelta", text: piece });
        }
        // Reasoning/thinking fields are never user-visible and never
        // protocol-significant: ignored here (they also must not mark the
        // stream usable on their own).
        const messageCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const rawCalls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : messageCalls;
        for (const [position, tc] of rawCalls.entries()) {
          if (!tc || typeof tc !== "object") continue;
          // Completed message calls have array positions, not delta indices.
          const index = Number.isSafeInteger(tc.index) ? tc.index : position;
          let slot = calls.get(index);
          if (!slot) {
            slot = { id: "", name: "", argsText: "", started: false };
            calls.set(index, slot);
          }
          if (typeof tc.id === "string" && tc.id) slot.id = tc.id.slice(0, 128);
          const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
          if (fn) {
            if (typeof fn.name === "string" && fn.name) slot.name = ((delta && Array.isArray(delta.tool_calls) ? slot.name : "") + fn.name).slice(0, 128);
            if (typeof fn.arguments === "string" && fn.arguments) {
              slot.argsText = (delta && Array.isArray(delta.tool_calls) ? slot.argsText : "") + fn.arguments;
              if (slot.argsText.length > maxToolArgsChars) {
                throw coded("tool args too large", "PROVIDER_UNAVAILABLE", "tool_arguments_limit");
              }
            }
          }
          if (!slot.started && (slot.id || slot.name)) {
            slot.started = true;
            await emit({
              type: "toolCallStart",
              providerCallId: slot.id || `index-${index}`,
              toolName: slot.name || "unknown",
            });
          }
          // Argument fragments are independent of the start event. Emit the
          // first fragment too so the extension can reconstruct exact args.
          if (slot.started && fn && typeof fn.arguments === "string" && fn.arguments) {
            await emit({
              type: "toolCallArgsDelta",
              providerCallId: slot.id || `index-${index}`,
              partialArgs: fn.arguments,
            });
          }
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
      // best-effort
    }
    try {
      reader.releaseLock();
    } catch (_) {
      // best-effort
    }
  }
  const postUsage = { inputTokens, outputTokens };
  if (signal && signal.aborted) {
    const err = coded("cancelled", "CANCELLED");
    err.providerAccepted = true;
    err.usage = postUsage;
    throw err;
  }
  // Emit ready events in index order after full assembly.
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
  const readyCalls = [];
  for (const [, slot] of ordered) {
    if (!slot.started) continue;
    const providerCallId = slot.id || "";
    if (!providerCallId) {
      const err = coded("provider omitted tool call id", "PROVIDER_UNAVAILABLE", "missing_tool_id");
      err.providerAccepted = true;
      err.usage = postUsage;
      throw err;
    }
    if (validateToolCall) {
      try { slot.argsText = JSON.stringify(validateToolCall(slot.name, JSON.parse(slot.argsText))); }
      catch (_) {
        const err = coded('Provider returned an invalid negotiated tool call.', 'PROVIDER_UNAVAILABLE', 'invalid_tool_call');
        err.providerAccepted = true; err.usage = postUsage; throw err;
      }
    }
    await emit({
      type: "toolCallReady",
      providerCallId,
      toolName: slot.name,
      argsText: slot.argsText,
    });
    readyCalls.push({ providerCallId, toolName: slot.name, argsText: slot.argsText });
  }
  if (!sawUsable && readyCalls.length === 0) {
    const err = coded("empty upstream stream", "PROVIDER_UNAVAILABLE", "empty_stream");
    err.providerAccepted = true;
    err.usage = postUsage;
    throw err;
  }
  return { inputTokens, outputTokens, finishReason, toolCalls: readyCalls, ...(Object.keys(reportedUsage).length ? { reportedUsage } : {}) };
}

function markPreAccept(err) {
  if (err && typeof err === "object" && err.providerAccepted === undefined) {
    err.providerAccepted = false;
  }
  return err;
}

async function streamManagedAgent({
  upstreamModelId,
  openRouterMessages,
  onEvent,
  signal,
  keyResolver,
  fetchImpl,
  maxOutputTokens,
  onBeforeProviderDispatch,
  onProviderAccepted,
  toolCapabilityVersion,
  agentMode,
  agentSkillsContext,
  answerOnly,
  nativeRequest,
}) {
  const d = { ...defaultDeps(), keyResolver: keyResolver || defaultDeps().keyResolver, fetchImpl: fetchImpl || defaultDeps().fetchImpl };
  if (typeof upstreamModelId !== "string" || !upstreamModelId) throw markPreAccept(coded("invalid model", "INTERNAL"));
  if (!Array.isArray(openRouterMessages) || openRouterMessages.length === 0) throw markPreAccept(coded("invalid messages", "INVALID_REQUEST"));
  if (typeof onEvent !== "function") throw markPreAccept(coded("invalid handler", "INTERNAL"));
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
      // best-effort
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
    if (typeof onBeforeProviderDispatch === "function") {
      await onBeforeProviderDispatch();
    }
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
          messages: openRouterMessages,
          ...(nativeRequest ? {
            ...(nativeRequest.tools.length ? { tools: nativeRequest.tools, tool_choice: nativeRequest.tool_choice || 'auto' } : {}),
            ...(nativeRequest.temperature === undefined ? {} : { temperature: nativeRequest.temperature }),
            ...(nativeRequest.top_p === undefined ? {} : { top_p: nativeRequest.top_p }),
          } : answerOnly === true ? {} : {
            tools: buildManagedAgentTools(toolCapabilityVersion, agentMode, agentSkillsContext),
            tool_choice: "auto",
          }),
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
      const err = markPreAccept(coded("upstream auth failed", "PROVIDER_AUTH_FAILED"));
      err.httpStatus = res.status;
      throw err;
    }
    if (res.status === 429) {
      const err = markPreAccept(coded("upstream rate limited", "PROVIDER_RATE_LIMITED"));
      err.retryAfterMs = parseProviderRetryAfterMs(res.headers);
      err.sharedFreeResetAtMs = parseSharedFreeResetAtMs(res.headers);
      if (err.sharedFreeResetAtMs) err.retryAfterMs = Math.max(err.retryAfterMs || 0, err.sharedFreeResetAtMs - Date.now());
      err.httpStatus = res.status;
      throw err;
    }
    if (res.status === 404) {
      // Unknown/stale upstream model mapping: model unavailable, not a
      // generic provider outage. Never include the model id or body.
      const err = markPreAccept(coded("upstream model not found", "MODEL_NOT_AVAILABLE"));
      err.httpStatus = res.status;
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = markPreAccept(coded("upstream unavailable", "PROVIDER_UNAVAILABLE"));
      err.httpStatus = res.status;
      err.retryAfterMs = parseProviderRetryAfterMs(res.headers);
      throw err;
    }
    if (!res.body || typeof res.body.getReader !== "function") {
      throw markPreAccept(coded("invalid upstream body", "PROVIDER_UNAVAILABLE"));
    }
    if (typeof onProviderAccepted === "function") {
      try {
        await onProviderAccepted();
      } catch (err) {
        try {
          upstream.abort();
        } catch (_) {
          // best-effort
        }
        throw err;
      }
    }
    const cancelled = () => callerAborted() || ceilingHit;
    try {
      return await parseUpstreamAgentStream(res.body, {
        signal: upstream.signal,
        onEvent: async event => {
          if (answerOnly === true && event.type.startsWith('toolCall')) {
            throw coded('Answer-only response requested a tool.', 'AGENT_INVALID_TOOL_CALL');
          }
          await onEvent(event);
        },
        isCancelled: cancelled,
        maxToolArgsChars: isFileToolCapability(toolCapabilityVersion) ? 100000 : 8000,
        ...(nativeRequest ? { validateToolCall: (name, args) => {
          if (!nativeRequest.tools.some(tool => tool.function.name === name)) throw coded('unadvertised native tool', 'AGENT_INVALID_TOOL_CALL');
          return args;
        } } : {}),
        ...(isCoordinationCapability(toolCapabilityVersion) ? { validateToolCall: (name, args) => require('./managedAgentValidator').validateManagedToolCall(toolCapabilityVersion, agentMode, name, args, agentSkillsContext) } : {}),
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
      // best-effort wipe
    }
  }
}

// Map canonical turns + backend system prompt to OpenRouter messages.
// Tool results become role=tool with tool_call_id; assistant tool calls
// become assistant with tool_calls array. providerCallId preserved exactly.
function toOpenRouterMessages(canonicalTurns, systemPrompt) {
  const out = [{ role: "system", content: systemPrompt }];
  for (const t of canonicalTurns) {
    if (t.role === "user") out.push({ role: "user", content: t.images?.length ? [
      { type: 'text', text: t.content },
      ...t.images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } })),
    ] : t.content });
    else if (t.role === "assistantText") out.push({ role: "assistant", content: t.content });
    else if (t.role === "assistantToolCalls") {
      out.push({
        role: "assistant",
        content: t.text || null,
        tool_calls: t.toolCalls.map((c, i) => ({
          id: c.providerCallId,
          type: "function",
          function: { name: c.toolName, arguments: JSON.stringify(c.args) },
        })),
      });
    } else if (t.role === "toolResult") {
      out.push({ role: "tool", tool_call_id: t.providerCallId, content: t.content });
    }
  }
  return out;
}

module.exports = {
  streamManagedAgent,
  toOpenRouterMessages,
  CHAT_URL,
  CONNECT_TIMEOUT_MS,
  STREAM_MAX_MS,
  MAX_RESPONSE_CHARS,
};
