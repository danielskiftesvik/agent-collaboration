// Classify why a cross-harness worker/reviewer run failed, so the driver can
// react: a subscription/rate limit or an auth problem makes the worker unusable
// *right now* and should trigger an auto-fallback to another worker-ready harness
// (with a clear note) rather than a silent single-party fallback to the driver.
//
// Signals are matched as a cross-harness UNION: the limit/auth text usually comes
// from the underlying model API and looks similar regardless of which CLI relayed
// it, so we don't gate patterns on `worker`. `worker` is kept for callers/logging.

// Subscription / rate / capacity limits — back off and try another harness.
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /\b529\b/,
  /rate[\s_-]?limit/i,
  /rate_limit_error/i,
  /usage limit/i,
  /\bquota\b/i,
  /resource_exhausted/i,
  /\boverloaded\b/i,
  /too many requests/i,
  /insufficient_quota/i
];

// Authentication / authorization — the worker can't run until the user logs in.
const AUTH_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /not authenticated/i,
  /authentication (failed|required|error)/i,
  /invalid[\s_-]?api[\s_-]?key/i,
  /please (run|log\s?in|sign\s?in|authenticate)/i,
  /\bre-?authenticate\b/i
];

// Best-effort reset-time hint, in priority order. First match wins.
const RESET_PATTERNS = [
  /resets?\s+at\s+([^\n.;]+)/i,
  /try again (?:in|at|after)\s+([^\n.;]+)/i,
  /retry[\s_-]?after[:\s]+([^\n.;]+)/i,
  /available again (?:in|at)\s+([^\n.;]+)/i
];

function extractResetAt(text) {
  for (const re of RESET_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Classify a failed run from its captured output.
 * @returns {{kind: "rate-limit"|"auth"|"other", resetAt: string|null, worker?: string}}
 */
export function classifyFailure({ stdout = "", stderr = "", exitCode, worker } = {}) {
  const text = `${stdout}\n${stderr}`;
  // Rate-limit is checked first: it's the focus, and quota/limit messages
  // sometimes also mention "login"/auth, but the right action is to back off.
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) {
    return { kind: "rate-limit", resetAt: extractResetAt(text), worker };
  }
  if (AUTH_PATTERNS.some((re) => re.test(text))) {
    return { kind: "auth", resetAt: null, worker };
  }
  return { kind: "other", resetAt: null, worker };
}

// Kinds that mean "this worker is unusable right now" → worth auto-falling-back
// to another worker-ready harness. "timeout"/"frozen" are included because a worker
// that blows the time budget or stops producing output is best handed to another
// worker rather than retried in place. "other" is a genuine task failure: don't mask
// it by silently retrying elsewhere.
const FALLBACK_KINDS = new Set(["rate-limit", "auth", "timeout", "frozen"]);

export function isFallbackKind(kind) {
  return FALLBACK_KINDS.has(kind);
}
