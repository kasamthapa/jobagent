import type Database from "better-sqlite3";
import { upsertMatch } from "../db/queries.js";
import type { LlmScoreResult } from "./types.js";

/**
 * The single chokepoint every matches-writing code path in src/scoring/
 * must go through. This exists because the cache-hit check in scorer.ts
 * (`match_content_hash === content_hash`) treats ANY non-empty content_hash
 * as "already scored, skip" — so recording a posting's real content_hash
 * for anything short of a genuine outcome makes it permanently unretriable.
 *
 * This has broken four separate times in production (missing API key,
 * retry exhaustion, deprecated-model 404s, a keyless/prefilter-only run
 * still hashing survivors it never sent to Gemini) because each failure
 * path called `upsertMatch` by hand and had to remember the invariant
 * itself. Routing every call through here — with `contentHash` only
 * reachable on the two outcome variants that are legitimately cacheable —
 * makes it a type error to write a real hash for anything else.
 */
export type MatchOutcome =
  /** Deterministic prefilter drop (senior title / non-engineering / region-locked). Never calls Gemini; legitimately cached. */
  | { kind: "prefiltered"; contentHash: string; reason: string }
  /** A genuine, successful, schema-validated Gemini response. Legitimately cached. */
  | { kind: "scored"; contentHash: string; result: LlmScoreResult }
  /**
   * Anything else: no API key configured, network error, timeout, retry
   * exhaustion, malformed/unparseable response, HTTP/model error (e.g. a
   * deprecated model 404ing). Deliberately has no `contentHash` field —
   * there is no such thing as a "correct" hash to record for a posting
   * that was never actually judged, so the type doesn't offer one.
   */
  | { kind: "unscored"; reason: string };

/**
 * Writes one posting's match row per `outcome`. `unscored` always forces
 * `content_hash` to `""` (matches.content_hash is `NOT NULL DEFAULT ''`,
 * so this is the schema's null-equivalent) regardless of what the posting's
 * real content_hash is — that empty string never equals a real sha256
 * content_hash, so the next `scorePostings` run always treats this posting
 * as a cache miss and retries it instead of skipping it forever.
 */
export function recordMatchResult(
  db: Database.Database,
  postingId: number,
  outcome: MatchOutcome,
  scoredAt: string,
): void {
  switch (outcome.kind) {
    case "prefiltered":
      upsertMatch(db, {
        postingId,
        contentHash: outcome.contentHash,
        score: 0,
        tier: "no",
        reasoning: `Prefiltered: ${outcome.reason}`,
        gapsJson: JSON.stringify([]),
        scoredAt,
      });
      return;
    case "scored":
      upsertMatch(db, {
        postingId,
        contentHash: outcome.contentHash,
        score: outcome.result.score,
        tier: outcome.result.tier,
        reasoning: outcome.result.reasoning,
        gapsJson: JSON.stringify(outcome.result.gaps),
        scoredAt,
      });
      return;
    case "unscored":
      upsertMatch(db, {
        postingId,
        contentHash: "",
        score: null,
        tier: null,
        reasoning: outcome.reason,
        gapsJson: null,
        scoredAt,
      });
      return;
  }
}
