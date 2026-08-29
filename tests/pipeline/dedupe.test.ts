import { describe, expect, it } from "vitest";
import { computeDedupeGroups, countDuplicates } from "../../src/pipeline/dedupe.js";
import type { PostingRow } from "../../src/db/queries.js";

function row(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    id: 1,
    source_id: 1,
    company_id: null,
    external_id: "1",
    title: "Junior Developer",
    description: "short",
    url: "https://example.test/1",
    location: null,
    location_policy: "unknown",
    timezone_requirement: null,
    salary_text: null,
    posted_at: null,
    deadline: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    is_open: 1,
    content_hash: "hash",
    dedupe_key: "acme::junior-developer",
    ...overrides,
  };
}

describe("computeDedupeGroups", () => {
  it("puts postings with distinct dedupe_keys into their own single-member groups", () => {
    const groups = computeDedupeGroups([
      row({ id: 1, dedupe_key: "acme::junior-developer" }),
      row({ id: 2, dedupe_key: "beta::backend-engineer" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.alternates.length === 0)).toBe(true);
  });

  it("collapses postings sharing a dedupe_key, picking the richest description as canonical", () => {
    const groups = computeDedupeGroups([
      row({ id: 1, source_id: 10, description: "short", first_seen_at: "2026-01-05T00:00:00.000Z" }),
      row({ id: 2, source_id: 20, description: "a much longer and richer job description", first_seen_at: "2026-01-01T00:00:00.000Z" }),
      row({ id: 3, source_id: 30, description: "mid length description here", first_seen_at: "2026-01-03T00:00:00.000Z" }),
    ]);

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.canonical.id).toBe(2);
    expect(group?.alternates.map((a) => a.id).sort()).toEqual([1, 3]);
  });

  it("uses the earliest first_seen_at across the group, even if it's not on the canonical row", () => {
    const groups = computeDedupeGroups([
      row({ id: 1, description: "a much longer and richer job description", first_seen_at: "2026-01-10T00:00:00.000Z" }),
      row({ id: 2, description: "short", first_seen_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(groups[0]?.canonical.id).toBe(1);
    expect(groups[0]?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("countDuplicates", () => {
  it("sums every group's alternates", () => {
    const groups = computeDedupeGroups([
      row({ id: 1, dedupe_key: "a" }),
      row({ id: 2, dedupe_key: "a" }),
      row({ id: 3, dedupe_key: "a" }),
      row({ id: 4, dedupe_key: "b" }),
    ]);
    expect(countDuplicates(groups)).toBe(2);
  });
});
