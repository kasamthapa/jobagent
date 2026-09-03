import type Database from "better-sqlite3";
import { listOpenPostingsForScoring, type PostingForScoring } from "../db/queries.js";
import { applyRemotePenalty, scoreWithGemini, type GeminiOptions } from "./gemini.js";
import { prefilterPosting } from "./prefilter.js";
import { recordMatchResult } from "./record.js";
import type { Profile } from "./types.js";

export interface ScoreSummary {
  /** Every open posting considered this run — the denominator for the cache hit rate. */
  totalOpen: number;
  /** Posting already has a match scored against its current content_hash — skipped entirely. */
  cacheHits: number;
  /** No match yet, or content_hash changed since the last score. */
  cacheMisses: number;
  /** Cache misses the cheap prefilter dropped before spending an LLM call. */
  prefilterDropped: number;
  /** Cache misses successfully scored by Gemini. */
  llmScored: number;
  /** Cache misses where the LLM call/parse failed (or no API key was configured). */
  llmFailed: number;
  tierCounts: Record<"safe" | "stretch" | "reach" | "no" | "unscored", number>;
}

export interface ScoreOptions {
  profile: Profile;
  /** null when no GEMINI_API_KEY is configured — every survivor is recorded as unscored rather than calling out. */
  gemini: GeminiOptions | null;
  now?: () => string;
}

function emptySummary(totalOpen: number): ScoreSummary {
  return {
    totalOpen,
    cacheHits: 0,
    cacheMisses: 0,
    prefilterDropped: 0,
    llmScored: 0,
    llmFailed: 0,
    tierCounts: { safe: 0, stretch: 0, reach: 0, no: 0, unscored: 0 },
  };
}

/**
 * Scores every open posting that hasn't already been scored against its
 * current content_hash. A cache hit (match's content_hash still equals the
 * posting's content_hash) is skipped entirely — no prefilter re-run, no LLM
 * call. Everything else runs through the cheap prefilter first; only
 * survivors cost a Gemini call. See PLAN.md Phase 4.
 */
export async function scorePostings(
  db: Database.Database,
  opts: ScoreOptions,
): Promise<ScoreSummary> {
  const now = opts.now ?? (() => new Date().toISOString());
  const candidates = listOpenPostingsForScoring(db);
  const summary = emptySummary(candidates.length);

  for (const posting of candidates) {
    if (posting.match_content_hash === posting.content_hash) {
      summary.cacheHits++;
      continue;
    }
    summary.cacheMisses++;
    await scoreOne(db, posting, opts, now, summary);
  }

  return summary;
}

async function scoreOne(
  db: Database.Database,
  posting: PostingForScoring,
  opts: ScoreOptions,
  now: () => string,
  summary: ScoreSummary,
): Promise<void> {
  const prefilter = prefilterPosting(
    { title: posting.title, locationPolicy: posting.location_policy },
    posting.market,
  );
  if (prefilter.drop) {
    summary.prefilterDropped++;
    summary.tierCounts.no++;
    recordMatchResult(
      db,
      posting.id,
      {
        kind: "prefiltered",
        contentHash: posting.content_hash,
        reason: prefilter.reason ?? "prefiltered",
      },
      now(),
    );
    return;
  }

  if (!opts.gemini) {
    summary.llmFailed++;
    summary.tierCounts.unscored++;
    recordMatchResult(
      db,
      posting.id,
      { kind: "unscored", reason: "LLM scoring skipped: no GEMINI_API_KEY configured" },
      now(),
    );
    return;
  }

  const outcome = await scoreWithGemini(
    {
      title: posting.title,
      description: posting.description ?? "",
      market: posting.market,
      location: posting.location,
      locationPolicy: posting.location_policy,
      timezoneRequirement: posting.timezone_requirement,
    },
    opts.profile,
    opts.gemini,
  );

  if (!outcome.ok) {
    summary.llmFailed++;
    summary.tierCounts.unscored++;
    recordMatchResult(
      db,
      posting.id,
      { kind: "unscored", reason: `LLM scoring failed: ${outcome.error}` },
      now(),
    );
    return;
  }

  const penalized = applyRemotePenalty(outcome.value, posting.market);
  summary.llmScored++;
  summary.tierCounts[penalized.tier]++;
  recordMatchResult(
    db,
    posting.id,
    { kind: "scored", contentHash: posting.content_hash, result: penalized },
    now(),
  );
}
