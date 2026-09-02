import { z } from "zod";
import type { Market } from "../sources/types.js";
import { buildScoringPrompt, type PromptPosting } from "./prompt.js";
import type { LlmScoreResult, Profile } from "./types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

/** Junior remote international hiring is far more competitive than Nepal — see CLAUDE.md/PLAN.md. */
const REMOTE_PENALTY = 15;

/** Gemini can hang with no error on a slow/dropped connection — abort rather than block the run. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Backoff before the single retry in `scoreWithGemini`, per PLAN.md Phase 6. */
const RETRY_BACKOFF_MS = 2_000;

/**
 * Gemini's free tier caps at 10 requests/minute; default to 8 to leave
 * headroom rather than skate the edge. A live run with no rate limiting
 * sustained ~44 req/min and produced nothing but 429s.
 */
const DEFAULT_RPM = 8;

const llmResponseSchema = z.object({
  score: z.number().int().min(0).max(100),
  tier: z.enum(["safe", "stretch", "reach", "no"]),
  reasoning: z.string().min(1),
  gaps: z.array(z.string()),
}) satisfies z.ZodType<LlmScoreResult>;

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Defaults to 30s. Overridable for tests. */
  timeoutMs?: number;
  /** Backoff sleep before the retry. Defaults to a real 2s wait; overridable for tests. */
  delayImpl?: (ms: number) => Promise<void>;
  /** Defaults to a shared rate limiter capped at DEFAULT_RPM. Overridable for tests, or to share one limiter across a whole scoring run (see scorer.ts). */
  rateLimiter?: RateLimiter;
}

/** Thrown by `callGemini` when the request is aborted for taking longer than `timeoutMs`. */
export class GeminiTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Gemini API call timed out after ${timeoutMs / 1000}s`);
    this.name = "GeminiTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown by `callGemini` on a non-2xx response; carries the HTTP status so callers can tell a rate limit (429) apart from other errors. */
export class GeminiHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Gemini API responded with HTTP ${status}${status === 429 ? " (rate limited)" : ""}`);
    this.name = "GeminiHttpError";
    this.status = status;
  }
}

function delay(ms: number, impl?: (ms: number) => Promise<void>): Promise<void> {
  if (impl) return impl(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RateLimiter {
  /** Resolves once it's safe to send another request, sleeping first if called too soon after the last one. */
  wait(): Promise<void>;
}

/**
 * Fixed-delay rate limiter: `wait()` blocks until at least `60_000 / rpm` ms
 * have passed since the previous call resolved. Gemini scoring is always
 * sequential (scorer.ts awaits one posting at a time), so tracking a single
 * "last request time" — no queue — is enough to cap outbound requests to
 * `rpm`/minute.
 */
export function createRateLimiter(rpm: number = DEFAULT_RPM): RateLimiter {
  const minIntervalMs = 60_000 / rpm;
  let lastAt: number | null = null;
  return {
    async wait(): Promise<void> {
      if (lastAt !== null) {
        const remaining = minIntervalMs - (Date.now() - lastAt);
        if (remaining > 0) await delay(remaining);
      }
      lastAt = Date.now();
    },
  };
}

let defaultRateLimiter: RateLimiter | undefined;
function getDefaultRateLimiter(): RateLimiter {
  defaultRateLimiter ??= createRateLimiter();
  return defaultRateLimiter;
}

/** Strips ```json fences a model sometimes wraps its output in despite being told not to. */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * POSTs one prompt to the Gemini generateContent endpoint and returns its raw
 * text output. Aborts after `timeoutMs` (default 30s) and throws
 * `GeminiTimeoutError` rather than hanging indefinitely. Waits on the rate
 * limiter first so a scoring run never exceeds `DEFAULT_RPM` requests/minute.
 */
export async function callGemini(prompt: string, opts: GeminiOptions): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rateLimiter = opts.rateLimiter ?? getDefaultRateLimiter();
  await rateLimiter.wait();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
        }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    if (controller.signal.aborted) {
      throw new GeminiTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new GeminiHttpError(res.status);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Gemini response had no text content");
  }
  return text;
}

/** Outcome of `scoreWithGemini`: either a validated result, or the specific reason scoring gave up, for the caller to record. */
export type GeminiScoreOutcome = { ok: true; value: LlmScoreResult } | { ok: false; error: string };

function describeGeminiError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Scores one posting with Gemini, validating the response against
 * `llmResponseSchema`. Retries once, after a short backoff, on any failure
 * (timeout, network error, HTTP error, bad JSON, schema mismatch); if the
 * retry also fails, logs which posting failed and returns the failure
 * reason — the caller records it in `reasoning` and moves on to the next
 * posting rather than blocking the whole run.
 */
export async function scoreWithGemini(
  posting: PromptPosting,
  profile: Profile,
  opts: GeminiOptions,
): Promise<GeminiScoreOutcome> {
  const prompt = buildScoringPrompt(posting, profile);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callGemini(prompt, opts);
      const parsed: unknown = JSON.parse(stripFences(raw));
      return { ok: true, value: llmResponseSchema.parse(parsed) };
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await delay(RETRY_BACKOFF_MS, opts.delayImpl);
      }
    }
  }
  const message = describeGeminiError(lastError);
  console.error(`Gemini scoring failed for posting "${posting.title}": ${message}`);
  return { ok: false, error: message };
}

/**
 * Applies the remote penalty: a flat deduction from the score plus a note
 * in the reasoning. The tier itself is left as the model's holistic
 * judgment — only the number used for ranking within a tier is adjusted.
 * Nepal-market results pass through unchanged.
 */
export function applyRemotePenalty(result: LlmScoreResult, market: Market): LlmScoreResult {
  if (market !== "remote") return result;
  return {
    ...result,
    score: Math.max(0, result.score - REMOTE_PENALTY),
    reasoning: `${result.reasoning} (remote penalty of -${REMOTE_PENALTY} applied: junior remote international hiring is far more competitive than Nepal.)`,
  };
}
