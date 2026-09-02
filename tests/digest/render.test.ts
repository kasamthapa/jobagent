import { describe, expect, it } from "vitest";
import { renderDigestMarkdown } from "../../src/digest/render.js";
import { TIER_ORDER, type DigestData, type DigestEntry } from "../../src/digest/build.js";

function entry(overrides: Partial<DigestEntry> = {}): DigestEntry {
  return {
    title: "Junior Full-Stack Developer",
    companyName: "Acme",
    market: "remote",
    score: 78,
    tier: "stretch",
    reasoning: "Leans on Supabase and SSE streaming, both working skills.",
    gaps: ["Docker"],
    url: "https://example.test/job/1",
    alternateUrls: [],
    deadline: null,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function emptyData(overrides: Partial<DigestData> = {}): DigestData {
  return {
    generatedAt: "2026-09-02T08:00:00.000Z",
    since: null,
    tierGroups: TIER_ORDER.map((tier) => ({ tier, entries: [] })),
    totalNew: 0,
    closingSoon: [],
    sourceHealth: [],
    ...overrides,
  };
}

describe("renderDigestMarkdown", () => {
  it("titles the digest with the generation date", () => {
    const md = renderDigestMarkdown(emptyData());
    expect(md).toContain("# Job Digest — 2026-09-02");
  });

  it("says no new postings when totalNew is 0", () => {
    const md = renderDigestMarkdown(emptyData());
    expect(md).toContain("No new postings since the last digest.");
  });

  it("puts stretch before safe, reach, and no", () => {
    const data = emptyData({
      totalNew: 4,
      tierGroups: [
        { tier: "stretch", entries: [entry({ tier: "stretch", title: "Stretch Job" })] },
        { tier: "safe", entries: [entry({ tier: "safe", title: "Safe Job", score: 90 })] },
        { tier: "reach", entries: [entry({ tier: "reach", title: "Reach Job", score: 40 })] },
        { tier: "no", entries: [entry({ tier: "no", title: "No Job", score: 0 })] },
        { tier: "unscored", entries: [] },
      ],
    });
    const md = renderDigestMarkdown(data);
    const stretchIdx = md.indexOf("## Stretch");
    const safeIdx = md.indexOf("## Safe");
    const reachIdx = md.indexOf("## Reach");
    const noIdx = md.indexOf("## No");
    expect(stretchIdx).toBeGreaterThan(-1);
    expect(stretchIdx).toBeLessThan(safeIdx);
    expect(safeIdx).toBeLessThan(reachIdx);
    expect(reachIdx).toBeLessThan(noIdx);
  });

  it("renders an entry's title, company, market, score, reasoning, gaps, and link", () => {
    const data = emptyData({
      totalNew: 1,
      tierGroups: [{ tier: "stretch", entries: [entry()] }, ...TIER_ORDER.slice(1).map((tier) => ({ tier, entries: [] }))],
    });
    const md = renderDigestMarkdown(data);
    expect(md).toContain("### Junior Full-Stack Developer — Acme (remote)");
    expect(md).toContain("Score: 78 | Tier: stretch");
    expect(md).toContain("Leans on Supabase and SSE streaming");
    expect(md).toContain("Gaps: Docker");
    expect(md).toContain("Link: https://example.test/job/1");
  });

  it("lists alternate links when the job was also posted elsewhere", () => {
    const data = emptyData({
      totalNew: 1,
      tierGroups: [
        { tier: "stretch", entries: [entry({ alternateUrls: ["https://alt.test/1", "https://alt.test/2"] })] },
        ...TIER_ORDER.slice(1).map((tier) => ({ tier, entries: [] })),
      ],
    });
    const md = renderDigestMarkdown(data);
    expect(md).toContain("Also posted: https://alt.test/1, https://alt.test/2");
  });

  it("falls back to 'Unknown company' when companyName is null", () => {
    const data = emptyData({
      totalNew: 1,
      tierGroups: [
        { tier: "stretch", entries: [entry({ companyName: null })] },
        ...TIER_ORDER.slice(1).map((tier) => ({ tier, entries: [] })),
      ],
    });
    const md = renderDigestMarkdown(data);
    expect(md).toContain("Unknown company");
  });

  it("renders a closing-soon section with deadline and days remaining", () => {
    const data = emptyData({
      closingSoon: [
        { title: "Junior Dev", companyName: "Acme", url: "https://example.test/1", deadline: "2026-09-05", daysRemaining: 3 },
      ],
    });
    const md = renderDigestMarkdown(data);
    expect(md).toContain("## Closing soon (within 7 days)");
    expect(md).toContain("Junior Dev");
    expect(md).toContain("deadline 2026-09-05 (3 day(s))");
  });

  it("omits the closing-soon section entirely when there's nothing closing soon", () => {
    const md = renderDigestMarkdown(emptyData());
    expect(md).not.toContain("Closing soon");
  });

  it("renders a source health table with last polled time, count, and error", () => {
    const data = emptyData({
      sourceHealth: [
        { name: "remotive", market: "remote", lastPolledAt: "2026-09-02T07:00:00.000Z", lastResultCount: 12, lastError: null },
        { name: "merojob", market: "nepal", lastPolledAt: null, lastResultCount: null, lastError: "Selector matched 0 elements" },
      ],
    });
    const md = renderDigestMarkdown(data);
    expect(md).toContain("## Source health");
    expect(md).toContain("| remotive | remote | 2026-09-02T07:00:00.000Z | 12 |  |");
    expect(md).toContain("| merojob | nepal | never |  | Selector matched 0 elements |");
  });

  it("escapes pipe characters in table cells so they don't break the table", () => {
    const data = emptyData({
      sourceHealth: [
        { name: "weird", market: "nepal", lastPolledAt: null, lastResultCount: null, lastError: "boom | broke" },
      ],
    });
    const md = renderDigestMarkdown(data);
    expect(md).toContain("boom \\| broke");
  });
});
