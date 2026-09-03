import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "../../src/db/schema.js";
import { upsertSource, upsertPosting, type PostingUpsert } from "../../src/db/queries.js";
import { scorePostings } from "../../src/scoring/scorer.js";
import type { Profile } from "../../src/scoring/types.js";

const profile: Profile = {
  solid: ["React", "TypeScript"],
  working: ["Supabase/pgvector"],
  learning: ["DSA"],
  next: ["Docker"],
  constraints: {
    location: "Nepal (UTC+5:45)",
    workVisa: false,
    eligibility: "worldwide or contractor-eligible remote roles only",
    level: "entry/junior level only",
  },
};

function geminiResponse(body: object) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
  };
}

/**
 * Skips real rate-limit waits and retry backoff. Without this, tests that
 * call Gemini more than once (across one or more scorePostings runs) would
 * pile up real multi-second delays via gemini.ts's default rate limiter.
 */
const noRateLimit = { wait: async () => {} };
const noDelay = async () => {};

describe("scorePostings", () => {
  let db: Database.Database;
  let sourceId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    upsertSource(db, {
      name: "remotive",
      market: "remote",
      kind: "api",
      url: "https://example.test",
      adapter: "remotive",
      active: true,
    });
    sourceId = (db.prepare(`SELECT id FROM sources WHERE name = 'remotive'`).get() as { id: number }).id;
  });

  function insertPosting(overrides: Partial<PostingUpsert> = {}): number {
    const { id } = upsertPosting(db, {
      sourceId,
      companyId: null,
      externalId: overrides.externalId ?? "ext-1",
      title: "Junior Full-Stack Developer",
      description: "Build things with React and Node.",
      url: "https://example.test/1",
      location: "Anywhere",
      locationPolicy: "worldwide",
      timezoneRequirement: null,
      salaryText: null,
      postedAt: null,
      deadline: null,
      contentHash: "hash-1",
      dedupeKey: "acme::junior-full-stack-developer",
      now: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });
    return id;
  }

  it("drops a senior title via the prefilter without calling Gemini", async () => {
    insertPosting({ title: "Senior Full-Stack Developer" });
    const fetchImpl = vi.fn();

    const summary = await scorePostings(db, {
      profile,
      gemini: { apiKey: "key", fetchImpl, rateLimiter: noRateLimit },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ totalOpen: 1, cacheMisses: 1, prefilterDropped: 1, llmScored: 0 });
    expect(summary.tierCounts.no).toBe(1);

    const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
    expect(match.tier).toBe("no");
    expect(match.reasoning).toMatch(/Prefiltered/);
  });

  it("scores a survivor via Gemini and applies the remote penalty", async () => {
    insertPosting();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(geminiResponse({ score: 70, tier: "stretch", reasoning: "Good fit.", gaps: ["Docker"] }));

    const summary = await scorePostings(db, {
      profile,
      gemini: { apiKey: "key", fetchImpl, rateLimiter: noRateLimit },
    });

    expect(summary.llmScored).toBe(1);
    expect(summary.tierCounts.stretch).toBe(1);

    const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
    expect(match.score).toBe(55); // 70 - 15 remote penalty
    expect(match.tier).toBe("stretch");
    expect(String(match.reasoning)).toContain("remote penalty");
    expect(JSON.parse(match.gaps_json as string)).toEqual(["Docker"]);
  });

  it("skips LLM scoring and records unscored matches when gemini is null", async () => {
    insertPosting();
    const summary = await scorePostings(db, { profile, gemini: null });

    expect(summary.llmFailed).toBe(1);
    expect(summary.tierCounts.unscored).toBe(1);

    const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
    expect(match.score).toBeNull();
    expect(match.tier).toBeNull();
    expect(match.reasoning).toMatch(/no GEMINI_API_KEY/);
    // The bug this regresses: a keyless run must NOT cache the posting's
    // real content_hash, or it becomes permanently unretriable — see
    // recordMatchResult in src/scoring/record.ts.
    expect(match.content_hash).toBe("");
  });

  it("is a cache hit on a second run when content_hash is unchanged, and does not call Gemini again", async () => {
    insertPosting();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(geminiResponse({ score: 70, tier: "stretch", reasoning: "Good fit.", gaps: [] }));

    const gemini = { apiKey: "key", fetchImpl, rateLimiter: noRateLimit };
    await scorePostings(db, { profile, gemini });
    const summary = await scorePostings(db, { profile, gemini });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({ cacheHits: 1, cacheMisses: 0, llmScored: 0 });
  });

  it("re-scores when content_hash changes, replacing the old match row rather than adding a second one", async () => {
    insertPosting();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(geminiResponse({ score: 70, tier: "stretch", reasoning: "First.", gaps: [] }))
      .mockResolvedValueOnce(geminiResponse({ score: 40, tier: "reach", reasoning: "Second.", gaps: ["Docker"] }));
    const gemini = { apiKey: "key", fetchImpl, rateLimiter: noRateLimit };

    await scorePostings(db, { profile, gemini });
    insertPosting({ contentHash: "hash-2", now: "2026-01-02T00:00:00.000Z" });
    const summary = await scorePostings(db, { profile, gemini });

    expect(summary).toMatchObject({ cacheHits: 0, cacheMisses: 1, llmScored: 1 });
    const matches = db.prepare(`SELECT * FROM matches`).all();
    expect(matches).toHaveLength(1);
    const match = matches[0] as Record<string, unknown>;
    expect(match.tier).toBe("reach");
    expect(match.score).toBe(25); // 40 - 15 remote penalty
  });

  it("records the specific failure reason in reasoning, e.g. a 429 rate limit, instead of a flat generic string", async () => {
    insertPosting();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    const summary = await scorePostings(db, {
      profile,
      gemini: { apiKey: "key", fetchImpl, delayImpl: noDelay, rateLimiter: noRateLimit },
    });

    expect(summary.llmFailed).toBe(1);
    const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
    expect(match.tier).toBeNull();
    expect(String(match.reasoning)).toContain("429");
    expect(match.content_hash).toBe("");
  });

  it("retries a previously-failed posting on the next run rather than treating it as a cache hit forever", async () => {
    insertPosting();
    const fetchImpl = vi
      .fn()
      // Both attempts of the first scorePostings run fail (retry included)...
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 429 })
      // ...then the retry on the second run succeeds.
      .mockResolvedValueOnce(geminiResponse({ score: 70, tier: "stretch", reasoning: "Good fit.", gaps: [] }));
    const gemini = { apiKey: "key", fetchImpl, delayImpl: noDelay, rateLimiter: noRateLimit };

    const first = await scorePostings(db, { profile, gemini });
    expect(first).toMatchObject({ cacheMisses: 1, llmFailed: 1 });

    const second = await scorePostings(db, { profile, gemini });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(second).toMatchObject({ cacheHits: 0, cacheMisses: 1, llmScored: 1 });
    const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
    expect(match.tier).toBe("stretch");
  });

  it("does not score closed postings", async () => {
    const { closeStalePostings } = await import("../../src/db/queries.js");
    insertPosting();
    closeStalePostings(db, sourceId, []);

    const summary = await scorePostings(db, { profile, gemini: null });
    expect(summary.totalOpen).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM matches`).get()).toEqual({ n: 0 });
  });
});
