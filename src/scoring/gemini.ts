import { z } from "zod";
import type { Market } from "../sources/types.js";
import { buildScoringPrompt, type PromptPosting } from "./prompt.js";
import type { LlmScoreResult, Profile } from "./types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

/** Junior remote international hiring is far more competitive than Nepal — see CLAUDE.md/PLAN.md. */
const REMOTE_PENALTY = 15;

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
}

/** Strips ```json fences a model sometimes wraps its output in despite being told not to. */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** POSTs one prompt to the Gemini generateContent endpoint and returns its raw text output. */
export async function callGemini(prompt: string, opts: GeminiOptions): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const res = await fetchFn(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
      }),
    },
  );
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
 * `llmResponseSchema`. Retries once on any failure (network/HTTP error, bad
 * JSON, schema mismatch), then gives up and returns null — the caller
 * records score=null and moves on rather than blocking the whole run.
 */
export async function scoreWithGemini(
  posting: PromptPosting,
  profile: Profile,
  opts: GeminiOptions,
): Promise<LlmScoreResult | null> {
  const prompt = buildScoringPrompt(posting, profile);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callGemini(prompt, opts);
      const parsed: unknown = JSON.parse(stripFences(raw));
      return llmResponseSchema.parse(parsed);
    } catch {
      if (attempt === 2) return null;
    }
  }
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
