import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "../../src/db/schema.js";
import { upsertSource } from "../../src/db/queries.js";
import { applyPoll, computeContentHash, computeDedupeKey } from "../../src/pipeline/upsert.js";
import type { RawPosting } from "../../src/sources/types.js";

const jobA: RawPosting = {
  externalId: "a1",
  title: "Junior Full-Stack Developer",
  description: "Build stuff with React and Node.",
  url: "https://example.test/jobs/a1",
  companyName: "Acme",
};

const jobB: RawPosting = {
  externalId: "b2",
  title: "Backend Engineer",
  description: "Own the API.",
  url: "https://example.test/jobs/b2",
  companyName: "Beta",
};

describe("computeContentHash / computeDedupeKey", () => {
  it("is stable for the same title+description and changes when either changes", () => {
    const h1 = computeContentHash("Title", "Description");
    const h2 = computeContentHash("Title", "Description");
    const h3 = computeContentHash("Title", "Different");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("normalizes company+title so the same job collapses across sources", () => {
    expect(computeDedupeKey("Acme Corp!", "Junior Dev")).toBe(computeDedupeKey("acme corp", "junior dev"));
  });
});

describe("applyPoll", () => {
  let db: Database.Database;
  let sourceId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    upsertSource(db, {
      name: "test-source",
      market: "remote",
      kind: "api",
      url: "https://example.test",
      adapter: "test",
      active: true,
    });
    const row = db.prepare(`SELECT id FROM sources WHERE name = 'test-source'`).get() as { id: number };
    sourceId = row.id;
  });

  it("inserts new postings, setting first_seen_at and last_seen_at to the same timestamp", () => {
    const result = applyPoll(db, sourceId, "remote", [jobA], "2026-01-01T00:00:00.000Z");
    expect(result).toEqual({ inserted: 1, updated: 0, closed: 0 });

    const row = db.prepare(`SELECT * FROM postings WHERE external_id = 'a1'`).get() as Record<string, unknown>;
    expect(row.first_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.last_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.is_open).toBe(1);
    expect(row.dedupe_key).toBe(computeDedupeKey("Acme", "Junior Full-Stack Developer"));
  });

  it("updates last_seen_at but keeps first_seen_at on a repeat poll", () => {
    applyPoll(db, sourceId, "remote", [jobA], "2026-01-01T00:00:00.000Z");
    const result = applyPoll(db, sourceId, "remote", [jobA], "2026-01-02T00:00:00.000Z");
    expect(result).toEqual({ inserted: 0, updated: 1, closed: 0 });

    const row = db.prepare(`SELECT * FROM postings WHERE external_id = 'a1'`).get() as Record<string, unknown>;
    expect(row.first_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.last_seen_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("closes postings that drop out of the latest poll and reopens them if they come back", () => {
    applyPoll(db, sourceId, "remote", [jobA, jobB], "2026-01-01T00:00:00.000Z");
    applyPoll(db, sourceId, "remote", [jobA], "2026-01-02T00:00:00.000Z");

    const closedRow = db.prepare(`SELECT is_open FROM postings WHERE external_id = 'b2'`).get() as {
      is_open: number;
    };
    expect(closedRow.is_open).toBe(0);

    applyPoll(db, sourceId, "remote", [jobA, jobB], "2026-01-03T00:00:00.000Z");
    const reopenedRow = db.prepare(`SELECT is_open FROM postings WHERE external_id = 'b2'`).get() as {
      is_open: number;
    };
    expect(reopenedRow.is_open).toBe(1);
  });

  it("creates a company row per distinct (name, market) and links postings to it", () => {
    applyPoll(db, sourceId, "remote", [jobA], "2026-01-01T00:00:00.000Z");
    const companies = db.prepare(`SELECT * FROM companies`).all() as Array<{ name: string }>;
    expect(companies).toHaveLength(1);
    expect(companies[0]?.name).toBe("Acme");

    const posting = db.prepare(`SELECT company_id FROM postings WHERE external_id = 'a1'`).get() as {
      company_id: number;
    };
    expect(posting.company_id).toBe(1);
  });
});
