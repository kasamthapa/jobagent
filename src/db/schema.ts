import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB_PATH = "data/jobs.db";

export const TABLE_NAMES = ["sources", "companies", "postings", "matches"] as const;

/**
 * Opens (creating the file if necessary) the sqlite database at `path`,
 * applies pragmas, and idempotently creates every table. Safe to call on
 * every process start — this is what `cli.ts init` calls.
 */
export function openDb(path: string = DEFAULT_DB_PATH): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  createSchema(db);
  return db;
}

/** Idempotently creates every table used by the job agent. */
export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT NOT NULL UNIQUE,
      market             TEXT NOT NULL CHECK (market IN ('nepal', 'remote')),
      kind               TEXT NOT NULL CHECK (kind IN ('portal', 'careers', 'api', 'rss', 'ats')),
      url                TEXT,
      adapter            TEXT NOT NULL,
      active             INTEGER NOT NULL DEFAULT 1,
      last_polled_at     TEXT,
      last_result_count  INTEGER,
      last_error         TEXT
    );

    CREATE TABLE IF NOT EXISTS companies (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      market       TEXT NOT NULL CHECK (market IN ('nepal', 'remote')),
      careers_url  TEXT,
      ats_type     TEXT,
      ats_token    TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS postings (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id              INTEGER NOT NULL REFERENCES sources(id),
      company_id             INTEGER REFERENCES companies(id),
      external_id            TEXT NOT NULL,
      title                  TEXT NOT NULL,
      description            TEXT,
      url                    TEXT,
      location               TEXT,
      location_policy        TEXT NOT NULL DEFAULT 'unknown'
                                CHECK (location_policy IN ('worldwide', 'region_locked', 'unknown')),
      timezone_requirement   TEXT,
      salary_text            TEXT,
      posted_at              TEXT,
      deadline               TEXT,
      first_seen_at          TEXT NOT NULL,
      last_seen_at           TEXT NOT NULL,
      is_open                INTEGER NOT NULL DEFAULT 1,
      content_hash           TEXT NOT NULL,
      dedupe_key             TEXT NOT NULL,
      UNIQUE (source_id, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_postings_dedupe_key ON postings (dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_postings_content_hash ON postings (content_hash);

    CREATE TABLE IF NOT EXISTS matches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      posting_id    INTEGER NOT NULL REFERENCES postings(id),
      content_hash  TEXT NOT NULL DEFAULT '',
      score         INTEGER,
      tier          TEXT CHECK (tier IN ('safe', 'stretch', 'reach', 'no')),
      reasoning     TEXT,
      gaps_json     TEXT,
      scored_at     TEXT NOT NULL
    );
  `);

  ensureMatchesContentHashColumn(db);

  // One row per scored posting (CLAUDE.md): enforced via a unique index
  // rather than an inline UNIQUE constraint so it can be added to a
  // pre-Phase-4 `matches` table without rebuilding it. The old non-unique
  // index (Phase 1) is dropped first so it doesn't linger unenforced.
  db.exec(`
    DROP INDEX IF EXISTS idx_matches_posting_id;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_posting_id_unique ON matches (posting_id);
  `);
}

/** Migrates a pre-Phase-4 `matches` table (created without `content_hash`) in place. */
function ensureMatchesContentHashColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(matches)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "content_hash")) {
    db.exec(`ALTER TABLE matches ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
  }
}
