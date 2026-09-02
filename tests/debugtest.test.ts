import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/schema.js";
import { listMatchesForDigest } from "../src/db/queries.js";

// NOTE: this file should live at tests/db/queries.test.ts alongside the rest
// of that suite (see logs/decisions.md — sandbox permissions blocked `rm`
// during Phase 5 development, so this couldn't be moved/deleted in place).
describe("listMatchesForDigest", () => {
  it("passes through a null score/tier (an unscored match) rather than coercing it", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO sources (name, market, kind, url, adapter, active) VALUES ('s','remote','api','u','a',1)`,
    ).run();
    db.prepare(
      `INSERT INTO postings (source_id, external_id, title, description, url, location_policy, first_seen_at, last_seen_at, is_open, content_hash, dedupe_key)
       VALUES (1, 'x', 'T', 'D', 'u', 'worldwide', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, 'h', 'dk')`,
    ).run();
    db.prepare(
      `INSERT INTO matches (posting_id, content_hash, score, tier, reasoning, gaps_json, scored_at)
       VALUES (1, 'h', null, null, 'r', null, '2026-09-01T00:00:00.000Z')`,
    ).run();

    const rows = listMatchesForDigest(db);
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.score).toBeNull();
    expect(rows[0]?.tier).toBeNull();
  });

  it("excludes closed postings", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO sources (name, market, kind, url, adapter, active) VALUES ('s','remote','api','u','a',1)`,
    ).run();
    db.prepare(
      `INSERT INTO postings (source_id, external_id, title, description, url, location_policy, first_seen_at, last_seen_at, is_open, content_hash, dedupe_key)
       VALUES (1, 'x', 'T', 'D', 'u', 'worldwide', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 0, 'h', 'dk')`,
    ).run();
    db.prepare(
      `INSERT INTO matches (posting_id, content_hash, score, tier, reasoning, gaps_json, scored_at)
       VALUES (1, 'h', 80, 'stretch', 'r', null, '2026-09-01T00:00:00.000Z')`,
    ).run();

    const rows = listMatchesForDigest(db);
    db.close();

    expect(rows).toHaveLength(0);
  });
});
