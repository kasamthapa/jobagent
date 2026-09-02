import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/db/schema.js";
import { buildDigestData, TIER_ORDER } from "../../src/digest/build.js";

function seedSource(
  db: Database.Database,
  overrides: { name?: string; market?: "nepal" | "remote"; lastPolledAt?: string | null; lastResultCount?: number | null; lastError?: string | null } = {},
): number {
  const { name = "remotive", market = "remote", lastPolledAt = null, lastResultCount = null, lastError = null } = overrides;
  const info = db
    .prepare(`INSERT INTO sources (name, market, kind, url, adapter, active, last_polled_at, last_result_count, last_error)
               VALUES (?, ?, 'api', 'https://x.test', 'adapter', 1, ?, ?, ?)`)
    .run(name, market, lastPolledAt, lastResultCount, lastError);
  return info.lastInsertRowid as number;
}

function seedCompany(db: Database.Database, name: string, market: "nepal" | "remote"): number {
  const info = db.prepare(`INSERT INTO companies (name, market) VALUES (?, ?)`).run(name, market);
  return info.lastInsertRowid as number;
}

interface PostingSeed {
  sourceId: number;
  companyId?: number | null;
  externalId: string;
  title?: string;
  url?: string;
  deadline?: string | null;
  dedupeKey?: string;
  firstSeenAt?: string;
  description?: string;
}

function seedPosting(db: Database.Database, p: PostingSeed): number {
  const info = db
    .prepare(
      `INSERT INTO postings (source_id, company_id, external_id, title, description, url, location_policy, deadline, first_seen_at, last_seen_at, is_open, content_hash, dedupe_key)
       VALUES (@sourceId, @companyId, @externalId, @title, @description, @url, 'worldwide', @deadline, @firstSeenAt, @firstSeenAt, 1, @contentHash, @dedupeKey)`,
    )
    .run({
      sourceId: p.sourceId,
      companyId: p.companyId ?? null,
      externalId: p.externalId,
      title: p.title ?? "Junior Full-Stack Developer",
      description: p.description ?? "Build things.",
      url: p.url ?? `https://example.test/${p.externalId}`,
      deadline: p.deadline ?? null,
      firstSeenAt: p.firstSeenAt ?? "2026-09-01T00:00:00.000Z",
      contentHash: `hash-${p.externalId}`,
      dedupeKey: p.dedupeKey ?? `acme::${p.externalId}`,
    });
  return info.lastInsertRowid as number;
}

interface MatchSeed {
  postingId: number;
  score?: number | null;
  tier?: "safe" | "stretch" | "reach" | "no" | null;
  reasoning?: string | null;
  gaps?: string[] | null;
}

function seedMatch(db: Database.Database, m: MatchSeed): void {
  db.prepare(
    `INSERT INTO matches (posting_id, content_hash, score, tier, reasoning, gaps_json, scored_at)
     VALUES (@postingId, 'h', @score, @tier, @reasoning, @gapsJson, '2026-09-01T00:00:00.000Z')`,
  ).run({
    postingId: m.postingId,
    // `??` would fall back to the default on an intentionally-passed `null`
    // (e.g. an unscored match) too, so check `undefined` explicitly instead.
    score: m.score !== undefined ? m.score : 80,
    tier: m.tier !== undefined ? m.tier : "stretch",
    reasoning: m.reasoning !== undefined ? m.reasoning : "Good fit.",
    gapsJson: m.gaps ? JSON.stringify(m.gaps) : null,
  });
}

describe("buildDigestData", () => {
  it("includes a posting first seen after `since` and excludes one seen before it", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const oldPosting = seedPosting(db, { sourceId, externalId: "old", dedupeKey: "a::old", firstSeenAt: "2026-08-01T00:00:00.000Z" });
    const newPosting = seedPosting(db, { sourceId, externalId: "new", dedupeKey: "a::new", firstSeenAt: "2026-09-02T00:00:00.000Z" });
    seedMatch(db, { postingId: oldPosting });
    seedMatch(db, { postingId: newPosting });

    const data = buildDigestData(db, { since: "2026-09-01T00:00:00.000Z", now: () => "2026-09-02T12:00:00.000Z" });
    db.close();

    expect(data.totalNew).toBe(1);
    const titles = data.tierGroups.flatMap((g) => g.entries.map((e) => e.title));
    expect(titles).toHaveLength(1);
    const stretch = data.tierGroups.find((g) => g.tier === "stretch")!;
    expect(stretch.entries[0]?.firstSeenAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("treats since: null as the first run — everything scored counts as new", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const postingId = seedPosting(db, { sourceId, externalId: "a", firstSeenAt: "2020-01-01T00:00:00.000Z" });
    seedMatch(db, { postingId });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.totalNew).toBe(1);
  });

  it("excludes postings that were never scored (no match row)", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    seedPosting(db, { sourceId, externalId: "unscored" });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.totalNew).toBe(0);
  });

  it("groups a null-tier match under 'unscored'", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const postingId = seedPosting(db, { sourceId, externalId: "a" });
    seedMatch(db, { postingId, score: null, tier: null, reasoning: "LLM scoring skipped: no GEMINI_API_KEY configured" });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    const unscored = data.tierGroups.find((g) => g.tier === "unscored")!;
    expect(unscored.entries).toHaveLength(1);
  });

  it("collapses postings sharing a dedupe_key and lists the non-canonical ones as alternate links", () => {
    const db = openDb(":memory:");
    const sourceA = seedSource(db, { name: "remotive" });
    const sourceB = seedSource(db, { name: "arbeitnow" });
    const canonical = seedPosting(db, {
      sourceId: sourceA,
      externalId: "1",
      dedupeKey: "acme::junior-dev",
      url: "https://remotive.test/1",
      description: "a much longer and richer job description of the role",
    });
    const alt = seedPosting(db, {
      sourceId: sourceB,
      externalId: "2",
      dedupeKey: "acme::junior-dev",
      url: "https://arbeitnow.test/2",
      description: "short",
    });
    seedMatch(db, { postingId: canonical });
    seedMatch(db, { postingId: alt, score: 50, tier: "reach" });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.totalNew).toBe(1);
    const stretch = data.tierGroups.find((g) => g.tier === "stretch")!;
    expect(stretch.entries[0]?.url).toBe("https://remotive.test/1");
    expect(stretch.entries[0]?.alternateUrls).toEqual(["https://arbeitnow.test/2"]);
  });

  it("attaches the company name via the companies table join", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const companyId = seedCompany(db, "Acme Inc", "remote");
    const postingId = seedPosting(db, { sourceId, companyId, externalId: "a" });
    seedMatch(db, { postingId });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    const stretch = data.tierGroups.find((g) => g.tier === "stretch")!;
    expect(stretch.entries[0]?.companyName).toBe("Acme Inc");
  });

  it("parses the gaps_json array onto the entry", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const postingId = seedPosting(db, { sourceId, externalId: "a" });
    seedMatch(db, { postingId, gaps: ["Docker", "CI/CD"] });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    const stretch = data.tierGroups.find((g) => g.tier === "stretch")!;
    expect(stretch.entries[0]?.gaps).toEqual(["Docker", "CI/CD"]);
  });

  it("orders tierGroups as stretch, safe, reach, no, unscored regardless of insertion order", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const no = seedPosting(db, { sourceId, externalId: "no", dedupeKey: "a::no" });
    const unscored = seedPosting(db, { sourceId, externalId: "unscored", dedupeKey: "a::unscored" });
    const reach = seedPosting(db, { sourceId, externalId: "reach", dedupeKey: "a::reach" });
    const safe = seedPosting(db, { sourceId, externalId: "safe", dedupeKey: "a::safe" });
    const stretch = seedPosting(db, { sourceId, externalId: "stretch", dedupeKey: "a::stretch" });
    seedMatch(db, { postingId: no, tier: "no", score: 0 });
    seedMatch(db, { postingId: unscored, tier: null, score: null });
    seedMatch(db, { postingId: reach, tier: "reach", score: 40 });
    seedMatch(db, { postingId: safe, tier: "safe", score: 95 });
    seedMatch(db, { postingId: stretch, tier: "stretch", score: 75 });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.tierGroups.map((g) => g.tier)).toEqual(TIER_ORDER);
    expect(data.tierGroups.map((g) => g.tier)).toEqual(["stretch", "safe", "reach", "no", "unscored"]);
  });

  it("sorts entries within a tier by score descending", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const low = seedPosting(db, { sourceId, externalId: "low", dedupeKey: "a::low" });
    const high = seedPosting(db, { sourceId, externalId: "high", dedupeKey: "a::high" });
    seedMatch(db, { postingId: low, score: 60, tier: "stretch" });
    seedMatch(db, { postingId: high, score: 90, tier: "stretch" });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    const stretch = data.tierGroups.find((g) => g.tier === "stretch")!;
    expect(stretch.entries.map((e) => e.score)).toEqual([90, 60]);
  });

  it("includes a posting in closingSoon when its deadline is within 7 days, regardless of `since`", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const postingId = seedPosting(db, { sourceId, externalId: "a", deadline: "2026-09-05", firstSeenAt: "2026-01-01T00:00:00.000Z" });
    seedMatch(db, { postingId });

    // `since` is after firstSeenAt, so this posting would NOT count as "new" — closing soon should still surface it.
    const data = buildDigestData(db, { since: "2026-08-01T00:00:00.000Z", now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.totalNew).toBe(0);
    expect(data.closingSoon).toHaveLength(1);
    expect(data.closingSoon[0]?.deadline).toBe("2026-09-05");
    expect(data.closingSoon[0]?.daysRemaining).toBe(3);
  });

  it("excludes a deadline more than 7 days out", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const postingId = seedPosting(db, { sourceId, externalId: "a", deadline: "2026-10-01" });
    seedMatch(db, { postingId });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.closingSoon).toHaveLength(0);
  });

  it("excludes a deadline that has already passed", () => {
    const db = openDb(":memory:");
    const sourceId = seedSource(db);
    const postingId = seedPosting(db, { sourceId, externalId: "a", deadline: "2026-08-01" });
    seedMatch(db, { postingId });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.closingSoon).toHaveLength(0);
  });

  it("reports source health from the sources table", () => {
    const db = openDb(":memory:");
    seedSource(db, { name: "merojob", market: "nepal", lastPolledAt: "2026-09-02T06:00:00.000Z", lastResultCount: 0, lastError: "Selector matched 0 elements" });

    const data = buildDigestData(db, { since: null, now: () => "2026-09-02T00:00:00.000Z" });
    db.close();

    expect(data.sourceHealth).toContainEqual({
      name: "merojob",
      market: "nepal",
      lastPolledAt: "2026-09-02T06:00:00.000Z",
      lastResultCount: 0,
      lastError: "Selector matched 0 elements",
    });
  });
});
