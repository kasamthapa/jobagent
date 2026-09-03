import { GAP_LOOKBACK_DAYS, type GapsData, type GapSkillStat } from "./build.js";

const MARKET_LABELS: Record<string, string> = {
  nepal: "Nepal",
  remote: "Remote",
};

function renderSkillTable(stats: GapSkillStat[]): string {
  if (stats.length === 0) return "_No gap data in this window._";
  const lines = [`| Skill | Roles blocked |`, `|---|---|`];
  for (const s of stats) {
    lines.push(`| ${s.skill} | ${s.count} |`);
  }
  return lines.join("\n");
}

function renderImpact(data: GapsData): string {
  if (data.topImpact.length === 0) return "";
  const lines = [
    `## Impact of closing the top gaps`,
    "",
    `For each of the top 5 blocking skills, how many \`reach\`-tier postings would move into the \`stretch\` zone (PLAN.md's target) if that skill alone moved from missing to \`working\`:`,
    "",
  ];
  for (const i of data.topImpact) {
    lines.push(
      `- **${i.skill}** — blocks ${i.count} role(s); closing it would move ${i.wouldMoveToStretch} \`reach\`-tier posting(s) into \`stretch\`.`,
    );
  }
  return lines.join("\n");
}

/**
 * Renders assembled gap data (see build.ts) as the markdown written to
 * `out/gaps-YYYY-MM-DD.md`. Pure formatting — no DB access, no file I/O.
 */
export function renderGapsMarkdown(data: GapsData): string {
  const date = data.generatedAt.slice(0, 10);
  const sections: string[] = [`# Skill Gap Report — ${date}`, ""];

  sections.push(
    `_Analysis of ${data.reachCount} \`reach\`-tier and ${data.highNoCount} high-scoring \`no\`-tier ` +
      `posting(s) first seen in the last ${GAP_LOOKBACK_DAYS} days (since ${data.since.slice(0, 10)})._`,
  );
  sections.push("");

  if (data.totalCandidates === 0) {
    sections.push(
      "No `reach` or high-scoring `no`-tier postings in this window — nothing to report yet.",
      "",
    );
    return sections.join("\n");
  }

  sections.push(`## Top blocking skills (overall)`, "", renderSkillTable(data.overall), "");

  sections.push(`## By market`, "");
  for (const market of ["nepal", "remote"] as const) {
    sections.push(`### ${MARKET_LABELS[market]}`, "", renderSkillTable(data.byMarket[market]), "");
  }

  const impact = renderImpact(data);
  if (impact) sections.push(impact, "");

  return sections.join("\n");
}
