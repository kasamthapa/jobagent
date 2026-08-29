import type Database from "better-sqlite3";
import type { Market, SourceKind, Source } from "../sources/types.js";
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

/** Row counts for every table, keyed by table name. Used by `cli.ts init` to report progress. */
export function countTables(db: Database.Database): Record<(typeof TABLE_NAMES)[number], number> {
  const counts = {} as Record<(typeof TABLE_NAMES)[number], number>;
  for (const table of TABLE_NAMES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    counts[table] = row.n;
  }
  return counts;
}
