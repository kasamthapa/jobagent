import type Database from "better-sqlite3";
import { listGapCandidateMatches, type GapCandidateRow } from "../db/queries.js";
import type { Market } from "../sources/types.js";

/**
 * How far back to look for `reach`/high-scoring-`no` matches. 90 days is
 * long enough to smooth out week-to-week noise in a market this small
 * (Nepal's IT sector, plus the worldwide-eligible slice of remote postings)
 * without dragging in postings so old they no longer reflect what's being
 * hired for. See logs/decisions.md.
 */
export const GAP_LOOKBACK_DAYS = 90;

/**
 * A `no`-tier match only counts as a gap signal above this score. Most `no`
 * verdicts are wrong-level/wrong-discipline noise (and the prefilter itself
 * records score 0) — those don't tell the owner anything about skills. A
 * `no` that still scored reasonably well is a posting the owner was close
 * on, disqualified by something real, which is exactly the signal `gaps`
 * exists to surface. See logs/decisions.md.
 */
export const HIGH_NO_SCORE_THRESHOLD = 50;

export interface GapSkillStat {
  skill: string;
  /** Number of candidate postings (reach + high-scoring no) listing this skill as a gap. */
  count: number;
}

export interface GapImpact extends GapSkillStat {
  /**
   * Of the `reach`-tier postings blocked by this skill, how many have at
   * most one other gap — i.e. closing just this one skill would leave them
   * with 0-1 remaining gaps, which is the `stretch` zone (PLAN.md: `reach`
   * needs 2+ missing skills, `stretch` leans on `working`/`learning`).
   */
  wouldMoveToStretch: number;
}

export interface GapsData {
  generatedAt: string;
  /** ISO cutoff — postings first seen before this are outside the lookback window. */
  since: string;
  reachCount: number;
  highNoCount: number;
  totalCandidates: number;
  overall: GapSkillStat[];
  byMarket: Record<Market, GapSkillStat[]>;
  /** Top 5 overall gaps, each with its close-the-gap impact on `reach`-tier postings. */
  topImpact: GapImpact[];
}

export interface BuildGapsOptions {
  now?: () => string;
}

function parseGaps(gapsJson: string | null): string[] {
  if (!gapsJson) return [];
  try {
    const parsed: unknown = JSON.parse(gapsJson);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}

function rankSkills(counts: Map<string, number>): GapSkillStat[] {
  return [...counts.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
}

function tally(counts: Map<string, number>, skill: string): void {
  counts.set(skill, (counts.get(skill) ?? 0) + 1);
}

/**
 * Assembles everything `gaps` needs (PLAN.md Phase 7): every `reach` and
 * high-scoring `no` match from the last `GAP_LOOKBACK_DAYS` days, ranked by
 * how often each missing skill blocks a posting — overall and split by
 * market, since Nepal and remote want different things (CLAUDE.md) — plus,
 * for the top 5 overall gaps, how many `reach`-tier postings would cross
 * into the `stretch` zone if that one skill moved to `working`. Pure data
 * assembly — no file I/O, no console output (see cli.ts / render.ts).
 */
export function buildGapsData(db: Database.Database, opts: BuildGapsOptions = {}): GapsData {
  const now = opts.now ?? (() => new Date().toISOString());
  const generatedAt = now();
  const since = new Date(
    new Date(generatedAt).getTime() - GAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const rows: GapCandidateRow[] = listGapCandidateMatches(db, since);
  const candidates = rows.filter(
    (r) => r.tier === "reach" || (r.tier === "no" && (r.score ?? 0) >= HIGH_NO_SCORE_THRESHOLD),
  );
  const reachRows = candidates.filter((r) => r.tier === "reach");

  const overallCounts = new Map<string, number>();
  const marketCounts: Record<Market, Map<string, number>> = {
    nepal: new Map(),
    remote: new Map(),
  };

  for (const r of candidates) {
    for (const skill of parseGaps(r.gaps_json)) {
      tally(overallCounts, skill);
      tally(marketCounts[r.market], skill);
    }
  }

  const overall = rankSkills(overallCounts);
  const byMarket: Record<Market, GapSkillStat[]> = {
    nepal: rankSkills(marketCounts.nepal),
    remote: rankSkills(marketCounts.remote),
  };

  const topImpact: GapImpact[] = overall.slice(0, 5).map(({ skill, count }) => {
    const wouldMoveToStretch = reachRows.filter((r) => {
      const gaps = parseGaps(r.gaps_json);
      return gaps.includes(skill) && gaps.length <= 2;
    }).length;
    return { skill, count, wouldMoveToStretch };
  });

  return {
    generatedAt,
    since,
    reachCount: reachRows.length,
    highNoCount: candidates.length - reachRows.length,
    totalCandidates: candidates.length,
    overall,
    byMarket,
    topImpact,
  };
}
