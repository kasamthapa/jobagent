import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createSchema } from "../../src/db/schema.js";
import { upsertPosting, type PostingUpsert } from "../../src/db/queries.js";
import { recordMatchResult } from "../../src/scoring/record.js";
import type { LlmScoreResult } from "../../src/scoring/types.js";

/**
 * This is the test that should have caught all four prior incidents (missing
 * API key, retry exhaustion, deprecated-model 404s, a keyless/prefilter-only
 * run still hashing survivors): it enumerates every outcome recordMatchResult
 * can be asked to write and asserts the content_hash/tier invariant CLAUDE.md
 * and src/scoring/record.ts document — content_hash is non-empty ONLY for a
 * genuine Gemini success or a deterministic prefilter drop, and empty for
 * everything else — plus a static check that scorer.ts (the only other
 * module that touches `matches`) has no way around this chokepoint.
 */

function makeDb(): { db: Database.Database; postingId: number } {
  const db = new Database(":memory:");
  createSchema(db);
  const source = db
    .prepare(
      `INSERT INTO sources (name, market, kind, url, adapter, active) VALUES ('remotive','remote','api','https://example.test','remotive',1)`,
    )
    .run();
  const posting: PostingUpsert = {
    sourceId: source.lastInsertRowid as number,
    companyId: null,
    externalId: "ext-1",
    title: "Junior Full-Stack Developer",
    description: "Build things.",
    url: "https://example.test/1",
    location: "Anywhere",
    locationPolicy: "worldwide",
    timezoneRequirement: null,
    salaryText: null,
    postedAt: null,
    deadline: null,
    contentHash: "real-sha256-hash",
    dedupeKey: "acme::junior-full-stack-developer",
    now: "2026-01-01T00:00:00.000Z",
  };
  const { id } = upsertPosting(db, posting);
  return { db, postingId: id };
}

const llmResult: LlmScoreResult = {
  score: 70,
  tier: "stretch",
  reasoning: "Good fit.",
  gaps: ["Docker"],
};

describe("recordMatchResult invariant", () => {
  it("caches the real content_hash for a genuine Gemini success", () => {
    const { db, postingId } = makeDb();
    recordMatchResult(
      db,
      postingId,
      { kind: "scored", contentHash: "real-sha256-hash", result: llmResult },
      "2026-01-01T00:00:00.000Z",
    );
    const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
    expect(match.content_hash).toBe("real-sha256-hash");
    expect(match.tier).toBe("stretch");
  });

  it("caches the real content_hash for a deterministic prefilter drop", () => {
    const { db, postingId } = makeDb();
    recordMatchResult(
      db,
      postingId,
      { kind: "prefiltered", contentHash: "real-sha256-hash", reason: "senior title" },
      "2026-01-01T00:00:00.000Z",
    );
    const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
    expect(match.content_hash).toBe("real-sha256-hash");
    expect(match.tier).toBe("no");
  });

  it("never caches a content_hash for an unscored outcome — missing key, network failure, retry exhaustion, bad response, or anything else", () => {
    const reasons = [
      "LLM scoring skipped: no GEMINI_API_KEY configured",
      "LLM scoring failed: Gemini API responded with HTTP 429 (rate limited)",
      "LLM scoring failed: Gemini API responded with HTTP 404",
      "LLM scoring failed: Gemini API call timed out after 30s",
      "LLM scoring failed: Gemini response had no text content",
    ];
    for (const reason of reasons) {
      const { db, postingId } = makeDb();
      recordMatchResult(db, postingId, { kind: "unscored", reason }, "2026-01-01T00:00:00.000Z");
      const match = db.prepare(`SELECT * FROM matches`).get() as Record<string, unknown>;
      expect(match.content_hash).toBe("");
      expect(match.tier).toBeNull();
      expect(match.score).toBeNull();
    }
  });

  it("has no `contentHash` field available on the unscored variant at the type level (compile-time guard)", () => {
    // @ts-expect-error — unscored must never accept a contentHash; if this
    // ever stops erroring, the type-level protection has been weakened.
    const outcome: Parameters<typeof recordMatchResult>[2] = { kind: "unscored", contentHash: "x", reason: "x" };
    expect(outcome).toBeDefined();
  });

  it("scorer.ts — the only other module that writes to `matches` — never calls upsertMatch directly, only through recordMatchResult", () => {
    const scoringDir = fileURLToPath(new URL("../../src/scoring/", import.meta.url));
    const scorerSrc = readFileSync(`${scoringDir}scorer.ts`, "utf-8");
    expect(scorerSrc).not.toMatch(/\bupsertMatch\s*\(/);
    expect(scorerSrc).toMatch(/\brecordMatchResult\s*\(/);

    // And nothing else under src/scoring/ (bar record.ts itself, which is
    // allowed to call it) reaches for upsertMatch either — a future
    // adapter/pipeline file bypassing the chokepoint would trip this.
    for (const file of readdirSync(scoringDir)) {
      if (file === "record.ts" || !file.endsWith(".ts")) continue;
      const src = readFileSync(`${scoringDir}${file}`, "utf-8");
      expect(src, `${file} must not call upsertMatch directly`).not.toMatch(/\bupsertMatch\s*\(/);
    }
  });
});
