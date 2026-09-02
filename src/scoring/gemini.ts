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
}

/** Thrown by `callGemini` when the request is aborted for taking longer than `timeoutMs`. */
export class GeminiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Gemini API call timed out after ${timeoutMs}ms`);
    this.name = "GeminiTimeoutError";
  }
}

function delay(ms: number, impl?: (ms: number) => Promise<void>): Promise<void> {
  if (impl) return impl(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * `GeminiTimeoutError` rather than hanging indefinitely.
 */
export async function callGemini(prompt: string, opts: GeminiOptions): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    throw new Error(`Gemini API responded with HTTP ${res.status}`);
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

/**
 * Scores one posting with Gemini, validating the response against
 * `llmResponseSchema`. Retries once, after a short backoff, on any failure
 * (timeout, network error, HTTP error, bad JSON, schema mismatch); if the
 * retry also fails, logs which posting failed and returns null — the caller
 * records score=null and moves on to the next posting rather than blocking
 * the whole run.
 */
export async function scoreWithGemini(
  posting: PromptPosting,
  profile: Profile,
  opts: GeminiOptions,
): Promise<LlmScoreResult | null> {
  const prompt = buildScoringPrompt(posting, profile);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callGemini(prompt, opts);
      const parsed: unknown = JSON.parse(stripFences(raw));
      return llmResponseSchema.parse(parsed);
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await delay(RETRY_BACKOFF_MS, opts.delayImpl);
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`Gemini scoring failed for posting "${posting.title}": ${message}`);
  return null;
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
