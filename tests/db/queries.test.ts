import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema, openDb } from "../../src/db/schema.js";
import {
  upsertSource,
  listSources,
  getSourceByName,
  countTables,
  recordPollResult,
  getOrCreateCompany,
  upsertPosting,
  closeStalePostings,
  listOpenPostings,
  listOpenPostingsForScoring,
  listMatchesForDigest,
  upsertMatch,
  type PostingUpsert,
} from "../../src/db/queries.js";
import type { Source } from "../../src/sources/types.js";

const remotive: Source = {
  name: "remotive",
  market: "remote",
  kind: "api",
  url: "https://remotive.com/api/remote-jobs",
  adapter: "remotive",
  active: true,
};

describe("upsertSource / listSources / getSourceByName", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("inserts a new source", () => {
    upsertSource(db, remotive);
    const rows = listSources(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "remotive",
      market: "remote",
      kind: "api",
      url: remotive.url,
      adapter: "remotive",
      active: 1,
    });
  });

  it("updates config columns instead of duplicating on a repeat name", () => {
    upsertSource(db, remotive);
    upsertSource(db, { ...remotive, url: "https://remotive.com/api/v2", active: false });
    const rows = listSources(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe("https://remotive.com/api/v2");
    expect(rows[0]?.active).toBe(0);
  });

  it("looks up a source by name", () => {
    upsertSource(db, remotive);
    expect(getSourceByName(db, "remotive")?.name).toBe("remotive");
    expect(getSourceByName(db, "nope")).toBeUndefined();
  });
});

describe("countTables", () => {
  it("counts rows in every table, starting at zero", () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(countTables(db)).toEqual({ sources: 0, companies: 0, postings: 0, matches: 0 });
    upsertSource(db, remotive);
    expect(countTables(db).sources).toBe(1);
    db.close();
  });
});

describe("recordPollResult", () => {
  it("records a successful poll's health columns", () => {
    const db = new Database(":memory:");
    createSchema(db);
    upsertSource(db, remotive);
    const source = getSourceByName(db, "remotive")!;

    recordPollResult(db, source.id, "2026-01-01T00:00:00.000Z", 5, null);

    const row = getSourceByName(db, "remotive")!;
    expect(row.last_polled_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.last_result_count).toBe(5);
    expect(row.last_error).toBeNull();
  });

  it("records a failed poll's error and leaves the count null", () => {
    const db = new Database(":memory:");
    createSchema(db);
    upsertSource(db, remotive);
    const source = getSourceByName(db, "remotive")!;

    recordPollResult(db, source.id, "2026-01-01T00:00:00.000Z", null, "boom");

    const row = getSourceByName(db, "remotive")!;
    expect(row.last_result_count).toBeNull();
    expect(row.last_error).toBe("boom");
  });
});

describe("getOrCreateCompany", () => {
  it("creates a company once and reuses it for the same (name, market)", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const id1 = getOrCreateCompany(db, "Acme", "remote");
    const id2 = getOrCreateCompany(db, "Acme", "remote");
    expect(id1).toBe(id2);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM companies`).get() as { n: number }).n).toBe(1);
  });

  it("treats the same name in a different market as a distinct company", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const remoteId = getOrCreateCompany(db, "Acme", "remote");
    const nepalId = getOrCreateCompany(db, "Acme", "nepal");
    expect(remoteId).not.toBe(nepalId);
  });
});

describe("upsertPosting / closeStalePostings", () => {
  let db: Database.Database;
  let sourceId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    upsertSource(db, remotive);
    sourceId = getSourceByName(db, "remotive")!.id;
  });

  function posting(overrides: Partial<PostingUpsert> = {}): PostingUpsert {
    return {
      sourceId,
      companyId: null,
      externalId: "ext-1",
      title: "Junior Dev",
      description: "Do junior dev things.",
      url: "https://example.test/ext-1",
      location: null,
      locationPolicy: "worldwide",
      timezoneRequirement: null,
      salaryText: null,
      postedAt: null,
      deadline: null,
      contentHash: "hash-1",
      dedupeKey: "acme::junior-dev",
      now: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("inserts a new posting and reports isNew", () => {
    const { isNew } = upsertPosting(db, posting());
    expect(isNew).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM postings`).get() as { n: number }).n).toBe(1);
  });

  it("updates the existing row on a repeat (source_id, external_id) and reports isNew=false", () => {
    upsertPosting(db, posting());
    const { isNew, id } = upsertPosting(db, posting({ title: "Junior Dev (updated)", now: "2026-01-02T00:00:00.000Z" }));
    expect(isNew).toBe(false);
    const row = db.prepare(`SELECT * FROM postings WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row.title).toBe("Junior Dev (updated)");
    expect(row.first_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.last_seen_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("closeStalePostings marks postings not in the seen list as closed, leaving others open", () => {
    upsertPosting(db, posting({ externalId: "keep" }));
    upsertPosting(db, posting({ externalId: "drop" }));

    const closed = closeStalePostings(db, sourceId, ["keep"]);
    expect(closed).toBe(1);

    const rows = db.prepare(`SELECT external_id, is_open FROM postings ORDER BY external_id`).all() as Array<{
      external_id: string;
      is_open: number;
    }>;
    expect(rows).toEqual([
      { external_id: "drop", is_open: 0 },
      { external_id: "keep", is_open: 1 },
    ]);
  });

  it("closeStalePostings with an empty seen list closes every open posting for that source", () => {
    upsertPosting(db, posting({ externalId: "a" }));
    upsertPosting(db, posting({ externalId: "b" }));
    const closed = closeStalePostings(db, sourceId, []);
    expect(closed).toBe(2);
  });
});

describe("listOpenPostings", () => {
  it("returns only postings with is_open = 1", () => {
    const db = new Database(":memory:");
    createSchema(db);
    upsertSource(db, remotive);
    const sourceId = getSourceByName(db, "remotive")!.id;

    upsertPosting(db, {
      sourceId,
      companyId: null,
      externalId: "open",
      title: "Open Posting",
      description: "d",
      url: "https://example.test/open",
      location: null,
      locationPolicy: "worldwide",
      timezoneRequirement: null,
      salaryText: null,
      postedAt: null,
      deadline: null,
      contentHash: "h1",
      dedupeKey: "acme::open",
      now: "2026-01-01T00:00:00.000Z",
    });
    closeStalePostings(db, sourceId, []); // closes the row just inserted
    upsertPosting(db, {
      sourceId,
      companyId: null,
      externalId: "still-open",
      title: "Still Open Posting",
      description: "d",
      url: "https://example.test/still-open",
      location: null,
      locationPolicy: "worldwide",
      timezoneRequirement: null,
      salaryText: null,
      postedAt: null,
      deadline: null,
      contentHash: "h2",
      dedupeKey: "acme::still-open",
      now: "2026-01-01T00:00:00.000Z",
    });

    const open = listOpenPostings(db);
    expect(open.map((p) => p.external_id)).toEqual(["still-open"]);
  });
});

describe("listOpenPostingsForScoring / upsertMatch", () => {
  let db: Database.Database;
  let sourceId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    upsertSource(db, remotive);
    sourceId = getSourceByName(db, "remotive")!.id;
  });

  function posting(overrides: Partial<PostingUpsert> = {}): PostingUpsert {
    return {
      sourceId,
      companyId: null,
      externalId: "ext-1",
      title: "Junior Dev",
      description: "Do junior dev things.",
      url: "https://example.test/ext-1",
      location: null,
      locationPolicy: "worldwide",
      timezoneRequirement: null,
      salaryText: null,
      postedAt: null,
      deadline: null,
      contentHash: "hash-1",
      dedupeKey: "acme::junior-dev",
      now: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("includes the source's market and a null match_content_hash for a never-scored posting", () => {
    upsertPosting(db, posting());
    const rows = listOpenPostingsForScoring(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ market: "remote", match_content_hash: null });
  });

  it("excludes closed postings", () => {
    upsertPosting(db, posting());
    closeStalePostings(db, sourceId, []);
    expect(listOpenPostingsForScoring(db)).toHaveLength(0);
  });

  it("reflects the current match's content_hash once upsertMatch has run", () => {
    const { id } = upsertPosting(db, posting());
    upsertMatch(db, {
      postingId: id,
      contentHash: "hash-1",
      score: 80,
      tier: "safe",
      reasoning: "Needs only solid skills.",
      gapsJson: "[]",
      scoredAt: "2026-01-01T00:00:00.000Z",
    });
    const rows = listOpenPostingsForScoring(db);
    expect(rows[0]?.match_content_hash).toBe("hash-1");
  });

  it("upsertMatch replaces the existing row for a posting instead of inserting a second one", () => {
    const { id } = upsertPosting(db, posting());
    upsertMatch(db, {
      postingId: id,
      contentHash: "hash-1",
      score: 80,
      tier: "safe",
      reasoning: "first",
      gapsJson: "[]",
      scoredAt: "2026-01-01T00:00:00.000Z",
    });
    upsertMatch(db, {
      postingId: id,
      contentHash: "hash-2",
      score: 40,
      tier: "reach",
      reasoning: "second",
      gapsJson: '["Docker"]',
      scoredAt: "2026-01-02T00:00:00.000Z",
    });

    const rows = db.prepare(`SELECT * FROM matches`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe("reach");
    expect(rows[0]?.reasoning).toBe("second");
  });
});

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
