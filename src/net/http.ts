/**
 * Shared retry/backoff wrapper for outbound HTTP calls. PLAN.md Phase 6
 * extends the timeout+retry pattern already built for Gemini
 * (src/scoring/gemini.ts) to every other network call in the codebase: the
 * remote JSON/RSS adapters (src/sources/adapters/shared.ts) and the Nepal
 * HTML scrapers (src/sources/adapters/nepal-shared.ts), which sit on top of
 * this module rather than calling `fetch` directly.
 *
 * A network-level failure (fetch rejects, or the request times out) or a
 * transient HTTP status (429, or 5xx) gets one retry after a short backoff
 * by default; anything else — a successful response, or a non-retryable
 * error status like 404/403 — is returned as-is on the first attempt. This
 * function never throws on a non-2xx *response*; only a timeout or a
 * network-level failure that survives every retry rejects. Callers (shared.ts
 * / nepal-shared.ts) decide how to turn a non-ok Response into an error, same
 * as before this module existed.
 */

export interface FetchRetryOptions {
  /** Aborts one attempt after this many ms. Defaults to 15s. */
  timeoutMs?: number;
  /**
   * Backoff between attempts when the response carries no `Retry-After`
   * header. Defaults to 300ms — these are lightweight HTTP calls, not
   * quota-limited LLM calls (see Gemini's 2s), so a short fixed backoff is
   * enough to ride out a transient blip without materially slowing a poll.
   */
  backoffMs?: number;
  /** Additional attempts beyond the first. Defaults to 1 (two attempts total). */
  retries?: number;
  /** Overridable for tests; defaults to a real setTimeout-based sleep. */
  delayImpl?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BACKOFF_MS = 300;
const DEFAULT_RETRIES = 1;

/** Thrown when an attempt is aborted for taking longer than `timeoutMs`, on the final attempt. */
export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`GET ${url} timed out after ${timeoutMs / 1000}s`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function delay(ms: number, impl?: (ms: number) => Promise<void>): Promise<void> {
  if (impl) return impl(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Reads a `Retry-After` header as whole seconds, if present and numeric (the date form isn't handled — no source in this codebase sends it). */
function retryAfterMs(res: Response): number | null {
  const header = res.headers?.get?.("retry-after");
  const seconds = Number(header);
  return header && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * Fetches `url`, aborting each attempt after `timeoutMs` and retrying (by
 * default once) on a network error, a timeout, or a 429/5xx response —
 * waiting `backoffMs` (or the response's `Retry-After`, if longer) between
 * attempts. The final attempt's response or error is returned/thrown as-is,
 * whatever it is.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const isLastAttempt = attempt >= retries;
    try {
      const res = await fetchFn(url, { ...init, signal: controller.signal });
      if (isLastAttempt || res.ok || !isRetryableStatus(res.status)) {
        return res;
      }
      await delay(retryAfterMs(res) ?? backoffMs, opts.delayImpl);
    } catch (err) {
      const error = controller.signal.aborted ? new FetchTimeoutError(url, timeoutMs) : err;
      if (isLastAttempt) throw error;
      await delay(backoffMs, opts.delayImpl);
    } finally {
      clearTimeout(timer);
    }
  }
}
