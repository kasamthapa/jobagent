import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "../../src/db/schema.js";

function tableNames(db: Database.Database): string[] {
  // sqlite_sequence is an internal bookkeeping table SQLite creates
  // automatically because of AUTOINCREMENT columns — not one of ours.
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("createSchema", () => {
  it("creates all four tables", () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(tableNames(db)).toEqual(["companies", "matches", "postings", "sources"]);
    db.close();
  });

  it("is idempotent — calling it twice does not throw or duplicate tables", () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(() => createSchema(db)).not.toThrow();
    expect(tableNames(db)).toEqual(["companies", "matches", "postings", "sources"]);
    db.close();
  });

  it("rejects an invalid market on sources via the CHECK constraint", () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO sources (name, market, kind, adapter) VALUES ('x', 'mars', 'portal', 'x')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("rejects an invalid tier on matches via the CHECK constraint", () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.prepare(
      `INSERT INTO sources (name, market, kind, adapter) VALUES ('s', 'nepal', 'portal', 'a')`,
    ).run();
    db.prepare(
      `INSERT INTO postings (source_id, external_id, title, first_seen_at, last_seen_at, content_hash, dedupe_key)
       VALUES (1, 'e1', 't', '2026-01-01', '2026-01-01', 'h', 'd')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO matches (posting_id, tier, scored_at) VALUES (1, 'maybe', '2026-01-01')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("enforces one match row per posting_id", () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.prepare(
      `INSERT INTO sources (name, market, kind, adapter) VALUES ('s', 'nepal', 'portal', 'a')`,
    ).run();
    db.prepare(
      `INSERT INTO postings (source_id, external_id, title, first_seen_at, last_seen_at, content_hash, dedupe_key)
       VALUES (1, 'e1', 't', '2026-01-01', '2026-01-01', 'h', 'd')`,
    ).run();
    db.prepare(
      `INSERT INTO matches (posting_id, content_hash, scored_at) VALUES (1, 'h', '2026-01-01')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO matches (posting_id, content_hash, scored_at) VALUES (1, 'h2', '2026-01-02')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("migrates a pre-Phase-4 matches table (no content_hash column) in place", () => {
    const db = new Database(":memory:");
    // Simulate the Phase 1-3 schema: matches with no content_hash column and
    // a non-unique posting_id index, as an already-running install would have.
    db.exec(`
      CREATE TABLE matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        posting_id INTEGER NOT NULL,
        score INTEGER,
        tier TEXT,
        reasoning TEXT,
        gaps_json TEXT,
        scored_at TEXT NOT NULL
      );
      CREATE INDEX idx_matches_posting_id ON matches (posting_id);
    `);

    createSchema(db);

    const columns = (db.prepare(`PRAGMA table_info(matches)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain("content_hash");

    const indexes = db.prepare(`PRAGMA index_list(matches)`).all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(indexes.some((i) => i.name === "idx_matches_posting_id_unique" && i.unique === 1)).toBe(
      true,
    );
    db.close();
  });

  it("enforces UNIQUE(source_id, external_id) on postings", () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.prepare(
      `INSERT INTO sources (name, market, kind, adapter) VALUES ('s', 'nepal', 'portal', 'a')`,
    ).run();
    const insertPosting = () =>
      db
        .prepare(
          `INSERT INTO postings (source_id, external_id, title, first_seen_at, last_seen_at, content_hash, dedupe_key)
           VALUES (1, 'dup', 't', '2026-01-01', '2026-01-01', 'h', 'd')`,
        )
        .run();
    insertPosting();
    expect(insertPosting).toThrow();
    db.close();
  });
});

describe("openDb", () => {
  it("sets foreign_keys and WAL pragmas", async () => {
    const { openDb } = await import("../../src/db/schema.js");
    const db = openDb(":memory:");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});
