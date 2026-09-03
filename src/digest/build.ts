import type Database from "better-sqlite3";
import { computeDedupeGroups } from "../pipeline/dedupe.js";
import {
  listMatchesForDigest,
  listOpenPostings,
  listSources,
  type DigestMatchRow,
} from "../db/queries.js";
import type { Market, Tier } from "../sources/types.js";

/** Tier display order — `stretch` is the target zone (PLAN.md), so it leads. `unscored` covers matches with no LLM tier (skipped or failed). */
export const TIER_ORDER: Array<Tier | "unscored"> = ["stretch", "safe", "reach", "no", "unscored"];

export interface DigestEntry {
  title: string;
  companyName: string | null;
  market: Market;
  score: number | null;
  tier: Tier | null;
  reasoning: string | null;
  gaps: string[];
  url: string | null;
  /** Links to the same job on other sources it was also seen on, per the dedupe pipeline. */
  alternateUrls: string[];
  deadline: string | null;
  firstSeenAt: string;
}

export interface ClosingSoonEntry {
  title: string;
  companyName: string | null;
  url: string | null;
  deadline: string;
  daysRemaining: number;
}

export interface SourceHealthRow {
  name: string;
  market: Market;
  lastPolledAt: string | null;
  lastResultCount: number | null;
  lastError: string | null;
  /** Consecutive polls with 0 results or an error. See `recordPollResult` (db/queries.ts). */
  consecutiveZeroPolls: number;
}

/**
 * A source that returns nothing 3 polls running is very likely a silently
 * broken parser/selector rather than a genuinely dry job market — CLAUDE.md
 * calls this out as the main failure mode of the whole system, so the
 * digest opens with a loud warning once a source crosses this line.
 */
export const ZERO_RESULT_ALERT_THRESHOLD = 3;

export interface DigestData {
  generatedAt: string;
  since: string | null;
  tierGroups: Array<{ tier: Tier | "unscored"; entries: DigestEntry[] }>;
  totalNew: number;
  closingSoon: ClosingSoonEntry[];
  sourceHealth: SourceHealthRow[];
}

export interface BuildDigestOptions {
  /** `lastDigestAt` from the previous run's state — null means "never run", so everything counts as new. */
  since: string | null;
  now?: () => string;
}

const CLOSING_SOON_WINDOW_DAYS = 7;

function parseGaps(gapsJson: string | null): string[] {
  if (!gapsJson) return [];
  try {
    const parsed: unknown = JSON.parse(gapsJson);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}

/** Whole days from `now` to `deadline`, or null if `deadline` doesn't parse. Negative means already past. */
function daysUntil(deadline: string, now: Date): number | null {
  const target = new Date(deadline);
  if (Number.isNaN(target.getTime())) return null;
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Assembles everything `digest` needs: open, scored postings collapsed by
 * dedupe group, filtered to those first seen since the last digest run and
 * grouped by tier (stretch first); a "closing soon" list independent of the
 * new-since filter, since an upcoming deadline matters regardless of when
 * the digest last ran; and a source health table. Pure data assembly — no
 * file I/O, no console output (see cli.ts / render.ts).
 */
export function buildDigestData(db: Database.Database, opts: BuildDigestOptions): DigestData {
  const now = opts.now ?? (() => new Date().toISOString());
  const generatedAt = now();
  const nowDate = new Date(generatedAt);

  const matchesByPostingId = new Map<number, DigestMatchRow>(
    listMatchesForDigest(db).map((m) => [m.posting_id, m]),
  );
  const groups = computeDedupeGroups(listOpenPostings(db));

  const tierGroups = new Map<Tier | "unscored", DigestEntry[]>();
  for (const tier of TIER_ORDER) tierGroups.set(tier, []);
  const closingSoon: ClosingSoonEntry[] = [];

  for (const group of groups) {
    const match = matchesByPostingId.get(group.canonical.id);
    if (!match) continue; // never scored — the digest only reports on postings `score` has judged

    const deadline = match.deadline ?? group.alternates.find((a) => a.deadline)?.deadline ?? null;
    const entry: DigestEntry = {
      title: match.title,
      companyName: match.company_name,
      market: match.market,
      score: match.score,
      tier: match.tier,
      reasoning: match.reasoning,
      gaps: parseGaps(match.gaps_json),
      url: match.url,
      alternateUrls: group.alternates.map((a) => a.url).filter((u): u is string => !!u),
      deadline,
      firstSeenAt: group.firstSeenAt,
    };

    const isNew = opts.since === null || group.firstSeenAt > opts.since;
    if (isNew) {
      tierGroups.get(entry.tier ?? "unscored")!.push(entry);
    }

    if (deadline) {
      const daysRemaining = daysUntil(deadline, nowDate);
      if (daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= CLOSING_SOON_WINDOW_DAYS) {
        closingSoon.push({
          title: entry.title,
          companyName: entry.companyName,
          url: entry.url,
          deadline,
          daysRemaining,
        });
      }
    }
  }

  for (const entries of tierGroups.values()) {
    entries.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.title.localeCompare(b.title));
  }
  closingSoon.sort((a, b) => a.daysRemaining - b.daysRemaining || a.title.localeCompare(b.title));

  const totalNew = [...tierGroups.values()].reduce((sum, entries) => sum + entries.length, 0);

  const sourceHealth: SourceHealthRow[] = listSources(db).map((s) => ({
    name: s.name,
    market: s.market,
    lastPolledAt: s.last_polled_at,
    lastResultCount: s.last_result_count,
    lastError: s.last_error,
    consecutiveZeroPolls: s.consecutive_zero_polls,
  }));

  return {
    generatedAt,
    since: opts.since,
    tierGroups: TIER_ORDER.map((tier) => ({ tier, entries: tierGroups.get(tier)! })),
    totalNew,
    closingSoon,
    sourceHealth,
  };
}
