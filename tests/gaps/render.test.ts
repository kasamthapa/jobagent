import { describe, expect, it } from "vitest";
import { renderGapsMarkdown } from "../../src/gaps/render.js";
import { GAP_LOOKBACK_DAYS, type GapsData } from "../../src/gaps/build.js";

function emptyData(overrides: Partial<GapsData> = {}): GapsData {
  return {
    generatedAt: "2026-09-01T00:00:00.000Z",
    since: "2026-06-03T00:00:00.000Z",
    reachCount: 0,
    highNoCount: 0,
    totalCandidates: 0,
    overall: [],
    byMarket: { nepal: [], remote: [] },
    topImpact: [],
    ...overrides,
  };
}

describe("renderGapsMarkdown", () => {
  it("titles the report with the generation date", () => {
    const md = renderGapsMarkdown(emptyData());
    expect(md).toContain("# Skill Gap Report — 2026-09-01");
  });

  it("reports nothing to report when there are no candidates", () => {
    const md = renderGapsMarkdown(emptyData());
    expect(md).toContain("nothing to report yet");
  });

  it("summarizes the reach/high-no counts and lookback window", () => {
    const md = renderGapsMarkdown(emptyData({ reachCount: 3, highNoCount: 2, totalCandidates: 5 }));
    expect(md).toContain(`3 \`reach\`-tier and 2 high-scoring \`no\`-tier`);
    expect(md).toContain(`${GAP_LOOKBACK_DAYS} days`);
  });

  it("renders the overall skill table ranked by count", () => {
    const md = renderGapsMarkdown(
      emptyData({
        totalCandidates: 2,
        overall: [
          { skill: "Docker", count: 2 },
          { skill: "GraphQL", count: 1 },
        ],
      }),
    );
    expect(md).toContain("## Top blocking skills (overall)");
    const dockerIdx = md.indexOf("Docker");
    const graphqlIdx = md.indexOf("GraphQL");
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeLessThan(graphqlIdx);
    expect(md).toContain("| Docker | 2 |");
  });

  it("renders separate Nepal and Remote sections", () => {
    const md = renderGapsMarkdown(
      emptyData({
        totalCandidates: 2,
        byMarket: {
          nepal: [{ skill: "Java", count: 1 }],
          remote: [{ skill: "Kubernetes", count: 1 }],
        },
      }),
    );
    expect(md).toContain("### Nepal");
    expect(md).toContain("### Remote");
    expect(md).toContain("| Java | 1 |");
    expect(md).toContain("| Kubernetes | 1 |");
    expect(md.indexOf("### Nepal")).toBeLessThan(md.indexOf("### Remote"));
  });

  it("shows a placeholder when a market has no gap data", () => {
    const md = renderGapsMarkdown(
      emptyData({
        totalCandidates: 1,
        byMarket: { nepal: [], remote: [{ skill: "Kubernetes", count: 1 }] },
      }),
    );
    expect(md).toContain("_No gap data in this window._");
  });

  it("renders the impact section for the top gaps", () => {
    const md = renderGapsMarkdown(
      emptyData({
        totalCandidates: 3,
        topImpact: [{ skill: "Docker", count: 3, wouldMoveToStretch: 2 }],
      }),
    );
    expect(md).toContain("## Impact of closing the top gaps");
    expect(md).toContain("**Docker** — blocks 3 role(s); closing it would move 2 `reach`-tier posting(s) into `stretch`.");
  });

  it("omits the impact section when there is nothing to report", () => {
    const md = renderGapsMarkdown(emptyData());
    expect(md).not.toContain("Impact of closing");
  });
});
