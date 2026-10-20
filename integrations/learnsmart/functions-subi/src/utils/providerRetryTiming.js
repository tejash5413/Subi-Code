/** Only a numeric delay crosses the provider boundary; never raw headers. */
function normalizeRetryAfterMs(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}

function parseProviderRetryAfterMs(headers, nowMs = Date.now()) {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const milliseconds = headers.get('retry-after-ms')?.trim();
  if (milliseconds && /^\d+$/.test(milliseconds)) {
    const delay = normalizeRetryAfterMs(Number(milliseconds));
    if (delay !== undefined) return delay;
  }
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return normalizeRetryAfterMs(Math.ceil(Number(value) * 1000));
  // Restrict dates to HTTP-date syntax so negative/nonsensical numbers
  // cannot be interpreted as dates by JavaScript's permissive parser.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? normalizeRetryAfterMs(Math.max(0, date - nowMs)) : undefined;
}

// OpenRouter platform rejections expose these headers; a provider-specific
// Retry-After alone must not disable every model in the shared free pool.
function parseSharedFreeResetAtMs(headers, nowMs = Date.now()) {
  if (!headers || typeof headers.get !== 'function' || headers.get('x-ratelimit-remaining')?.trim() !== '0') return undefined;
  const value = headers.get('x-ratelimit-reset')?.trim();
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const raw = Number(value);
  const reset = raw < 1e12 ? Math.ceil(raw * 1000) : Math.ceil(raw);
  return Number.isSafeInteger(reset) && reset > nowMs && reset <= nowMs + 86400000 ? reset : undefined;
}

module.exports = { normalizeRetryAfterMs, parseProviderRetryAfterMs, parseSharedFreeResetAtMs };
