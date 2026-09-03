import type Database from "better-sqlite3";
import type { LocationPolicy, Market, SourceKind, Source, Tier } from "../sources/types.js";
import { TABLE_NAMES } from "./schema.js";

/**
 * This module is the ONLY place in the codebase allowed to contain raw SQL
 * (alongside schema.ts). Everything else — cli.ts, pipeline, scoring —
 * calls these typed functions instead.
 */

export interface SourceRow {
  id: number;
  name: string;
  market: Market;
  kind: SourceKind;
  url: string | null;
  adapter: string;
  active: 0 | 1;
  last_polled_at: string | null;
  last_result_count: number | null;
  last_error: string | null;
  /** Consecutive polls (across the source's whole history) that returned 0 results or errored. Reset to 0 by any poll with >0 results. See `recordPollResult`. */
  consecutive_zero_polls: number;
}

/** Inserts a source, or updates its config columns if the name already exists. */
export function upsertSource(db: Database.Database, source: Source): void {
  db.prepare(
    `INSERT INTO sources (name, market, kind, url, adapter, active)
     VALUES (@name, @market, @kind, @url, @adapter, @active)
     ON CONFLICT(name) DO UPDATE SET
       market = excluded.market,
       kind = excluded.kind,
       url = excluded.url,
       adapter = excluded.adapter,
       active = excluded.active`,
  ).run({
    name: source.name,
    market: source.market,
    kind: source.kind,
    url: source.url,
    adapter: source.adapter,
    active: source.active ? 1 : 0,
  });
}

export function listSources(db: Database.Database): SourceRow[] {
  return db.prepare(`SELECT * FROM sources ORDER BY market, name`).all() as SourceRow[];
}

export function getSourceByName(db: Database.Database, name: string): SourceRow | undefined {
  return db.prepare(`SELECT * FROM sources WHERE name = ?`).get(name) as SourceRow | undefined;
}

/**
 * Records the outcome of one poll attempt against a source's health columns.
 * `consecutive_zero_polls` increments whenever this poll produced no data —
 * a successful fetch with 0 results, or an error (null resultCount) — and
 * resets to 0 the moment a poll comes back with >0 results. The digest
 * (Phase 6) opens with a loud warning once a source crosses the alert
 * threshold on this streak: a source that quietly stops finding anything is
 * the main failure mode of this whole system (CLAUDE.md).
 */
export function recordPollResult(
  db: Database.Database,
  sourceId: number,
  polledAt: string,
  resultCount: number | null,
  error: string | null,
): void {
  db.prepare(
    `UPDATE sources SET
       last_polled_at = ?,
       last_result_count = ?,
       last_error = ?,
       consecutive_zero_polls = CASE
         WHEN COALESCE(?, 0) = 0 THEN consecutive_zero_polls + 1
         ELSE 0
       END
     WHERE id = ?`,
  ).run(polledAt, resultCount, error, resultCount, sourceId);
}

/** Looks up a company by (name, market), creating it if it doesn't exist yet. Returns its id. */
export function getOrCreateCompany(db: Database.Database, name: string, market: Market): number {
  const existing = db
    .prepare(`SELECT id FROM companies WHERE name = ? AND market = ?`)
    .get(name, market) as { id: number } | undefined;
  if (existing) return existing.id;

  const info = db
    .prepare(`INSERT INTO companies (name, market) VALUES (?, ?)`)
    .run(name, market);
  return info.lastInsertRowid as number;
}

export interface PostingUpsert {
  sourceId: number;
  companyId: number | null;
  externalId: string;
  title: string;
  description: string;
  url: string;
  location: string | null;
  locationPolicy: LocationPolicy;
  timezoneRequirement: string | null;
  salaryText: string | null;
  postedAt: string | null;
  deadline: string | null;
  contentHash: string;
  dedupeKey: string;
  /** ISO timestamp used for `first_seen_at` (on insert) and `last_seen_at` (always). */
  now: string;
}

/**
 * Inserts a posting, or updates it (and marks it open again) if
 * (source_id, external_id) already exists. `first_seen_at` is set once, on
 * insert, and never touched again.
 */
export function upsertPosting(
  db: Database.Database,
  p: PostingUpsert,
): { id: number; isNew: boolean } {
  const existing = db
    .prepare(`SELECT id FROM postings WHERE source_id = ? AND external_id = ?`)
    .get(p.sourceId, p.externalId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE postings SET
         company_id = @companyId, title = @title, description = @description, url = @url,
         location = @location, location_policy = @locationPolicy,
         timezone_requirement = @timezoneRequirement, salary_text = @salaryText,
         posted_at = @postedAt, deadline = @deadline, last_seen_at = @now, is_open = 1,
         content_hash = @contentHash, dedupe_key = @dedupeKey
       WHERE id = @id`,
    ).run({ ...p, id: existing.id });
    return { id: existing.id, isNew: false };
  }

  const info = db
    .prepare(
      `INSERT INTO postings (
         source_id, company_id, external_id, title, description, url, location,
         location_policy, timezone_requirement, salary_text, posted_at, deadline,
         first_seen_at, last_seen_at, is_open, content_hash, dedupe_key
       ) VALUES (
         @sourceId, @companyId, @externalId, @title, @description, @url, @location,
         @locationPolicy, @timezoneRequirement, @salaryText, @postedAt, @deadline,
         @now, @now, 1, @contentHash, @dedupeKey
       )`,
    )
    .run(p);
  return { id: info.lastInsertRowid as number, isNew: true };
}

/**
 * Marks every open posting for `sourceId` NOT in `seenExternalIds` as
 * closed (is_open = 0) — i.e. it dropped out of the source's latest
 * successful poll. Returns the number of postings closed.
 */
export function closeStalePostings(
  db: Database.Database,
  sourceId: number,
  seenExternalIds: string[],
): number {
  if (seenExternalIds.length === 0) {
    const info = db
      .prepare(`UPDATE postings SET is_open = 0 WHERE source_id = ? AND is_open = 1`)
      .run(sourceId);
    return info.changes;
  }

  const placeholders = seenExternalIds.map(() => "?").join(", ");
  const info = db
    .prepare(
      `UPDATE postings SET is_open = 0
       WHERE source_id = ? AND is_open = 1 AND external_id NOT IN (${placeholders})`,
    )
    .run(sourceId, ...seenExternalIds);
  return info.changes;
}

export interface PostingRow {
  id: number;
  source_id: number;
  company_id: number | null;
  external_id: string;
  title: string;
  description: string | null;
  url: string | null;
  location: string | null;
  location_policy: LocationPolicy;
  timezone_requirement: string | null;
  salary_text: string | null;
  posted_at: string | null;
  deadline: string | null;
  first_seen_at: string;
  last_seen_at: string;
  is_open: 0 | 1;
  content_hash: string;
  dedupe_key: string;
}

/** Every currently-open posting. Used by the dedupe pipeline to group the same job across sources. */
export function listOpenPostings(db: Database.Database): PostingRow[] {
  return db.prepare(`SELECT * FROM postings WHERE is_open = 1`).all() as PostingRow[];
}

/** An open posting joined with its source's market and its current match's content_hash (Phase 4). */
export interface PostingForScoring extends PostingRow {
  market: Market;
  /** null when the posting has never been scored. */
  match_content_hash: string | null;
}

/**
 * Every open posting, alongside the market of the source it came from and
 * the content_hash its current match (if any) was scored against. The
 * scorer uses `match_content_hash === content_hash` to decide a cache hit
 * (skip re-scoring) vs. a cache miss (content changed, or never scored).
 */
export function listOpenPostingsForScoring(db: Database.Database): PostingForScoring[] {
  return db
    .prepare(
      `SELECT p.*, s.market AS market, m.content_hash AS match_content_hash
       FROM postings p
       JOIN sources s ON s.id = p.source_id
       LEFT JOIN matches m ON m.posting_id = p.id
       WHERE p.is_open = 1`,
    )
    .all() as PostingForScoring[];
}

export interface MatchUpsert {
  postingId: number;
  contentHash: string;
  score: number | null;
  tier: Tier | null;
  reasoning: string | null;
  gapsJson: string | null;
  scoredAt: string;
}

/**
 * Inserts a match, or replaces it in place if this posting already has one
 * — `matches` is one row per scored posting (CLAUDE.md), not a history log.
 */
export function upsertMatch(db: Database.Database, m: MatchUpsert): void {
  db.prepare(
    `INSERT INTO matches (posting_id, content_hash, score, tier, reasoning, gaps_json, scored_at)
     VALUES (@postingId, @contentHash, @score, @tier, @reasoning, @gapsJson, @scoredAt)
     ON CONFLICT(posting_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       score = excluded.score,
       tier = excluded.tier,
       reasoning = excluded.reasoning,
       gaps_json = excluded.gaps_json,
       scored_at = excluded.scored_at`,
  ).run(m);
}

export interface DigestMatchRow {
  posting_id: number;
  title: string;
  url: string | null;
  location: string | null;
  deadline: string | null;
  first_seen_at: string;
  dedupe_key: string;
  market: Market;
  company_name: string | null;
  score: number | null;
  tier: Tier | null;
  reasoning: string | null;
  gaps_json: string | null;
  scored_at: string;
}

/**
 * Every open, scored posting joined with its match, company name, and
 * source market — the digest's (Phase 5) primary data source. A posting
 * that's never been through `score` (no match row at all) is absent here;
 * the digest only reports on postings the scorer has judged.
 */
export function listMatchesForDigest(db: Database.Database): DigestMatchRow[] {
  return db
    .prepare(
      `SELECT p.id AS posting_id, p.title, p.url, p.location, p.deadline,
              p.first_seen_at, p.dedupe_key, s.market AS market,
              c.name AS company_name, m.score, m.tier, m.reasoning,
              m.gaps_json, m.scored_at
       FROM matches m
       JOIN postings p ON p.id = m.posting_id
       JOIN sources s ON s.id = p.source_id
       LEFT JOIN companies c ON c.id = p.company_id
       WHERE p.is_open = 1`,
    )
    .all() as DigestMatchRow[];
}

/** Runs `PRAGMA integrity_check` and returns its summary string (`"ok"` when healthy). */
export function checkIntegrity(db: Database.Database): string {
  const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  return result.map((r) => r.integrity_check).join("; ");
}

/** Every table name currently present in the database, per `sqlite_master`. */
export function listTableNames(db: Database.Database): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

/** Row counts for every table, keyed by table name. Used by `cli.ts init` to report progress. */
export function countTables(db: Database.Database): Record<(typeof TABLE_NAMES)[number], number> {
  const counts = {} as Record<(typeof TABLE_NAMES)[number], number>;
  for (const table of TABLE_NAMES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    counts[table] = row.n;
  }
  return counts;
}
