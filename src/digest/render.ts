import { ZERO_RESULT_ALERT_THRESHOLD, type DigestData } from "./build.js";

const TIER_LABELS: Record<string, string> = {
  stretch: "Stretch",
  safe: "Safe",
  reach: "Reach",
  no: "No",
  unscored: "Unscored",
};

/** Escapes pipe characters so free-text values can't break a markdown table row. */
function tableCell(value: string | number | null): string {
  if (value === null) return "";
  return String(value).replace(/\|/g, "\\|");
}

function renderEntry(entry: DigestData["tierGroups"][number]["entries"][number]): string {
  const lines: string[] = [];
  const company = entry.companyName ?? "Unknown company";
  lines.push(`### ${entry.title} — ${company} (${entry.market})`);
  lines.push(`- Score: ${entry.score ?? "n/a"} | Tier: ${entry.tier ?? "unscored"}`);
  if (entry.reasoning) lines.push(`- ${entry.reasoning}`);
  if (entry.gaps.length > 0) lines.push(`- Gaps: ${entry.gaps.join(", ")}`);
  if (entry.url) lines.push(`- Link: ${entry.url}`);
  if (entry.alternateUrls.length > 0) {
    lines.push(`- Also posted: ${entry.alternateUrls.join(", ")}`);
  }
  if (entry.deadline) lines.push(`- Deadline: ${entry.deadline}`);
  return lines.join("\n");
}

function renderClosingSoon(data: DigestData): string {
  if (data.closingSoon.length === 0) return "";
  const lines = [`## Closing soon (within 7 days)`, ""];
  for (const c of data.closingSoon) {
    const company = c.companyName ?? "Unknown company";
    const when = c.daysRemaining === 0 ? "today" : `${c.daysRemaining} day(s)`;
    const link = c.url ? ` — ${c.url}` : "";
    lines.push(`- **${c.title}** at ${company} — deadline ${c.deadline} (${when})${link}`);
  }
  return lines.join("\n");
}

/**
 * Renders a loud warning banner listing any source stuck at 0 results for
 * `ZERO_RESULT_ALERT_THRESHOLD`+ consecutive polls — a silently broken
 * parser/selector, the main failure mode this system is prone to
 * (CLAUDE.md). Returns "" when nothing has crossed the threshold, so the
 * digest stays quiet on a normal run.
 */
function renderSourceAlerts(data: DigestData): string {
  const stale = data.sourceHealth.filter((s) => s.consecutiveZeroPolls >= ZERO_RESULT_ALERT_THRESHOLD);
  if (stale.length === 0) return "";
  const lines = [
    `## ⚠️ SOURCE HEALTH ALERT`,
    "",
    `The following source(s) have returned 0 results for ${ZERO_RESULT_ALERT_THRESHOLD}+ consecutive polls — this usually means a silently broken parser/selector, not a dry market. Check them first:`,
    "",
  ];
  for (const s of stale) {
    const errorNote = s.lastError ? `, last error: ${s.lastError}` : "";
    lines.push(`- **${s.name}** (${s.market}) — ${s.consecutiveZeroPolls} consecutive empty polls${errorNote}`);
  }
  return lines.join("\n");
}

function renderSourceHealth(data: DigestData): string {
  const lines = [
    `## Source health`,
    "",
    `| Source | Market | Last polled | Results | Error |`,
    `|---|---|---|---|---|`,
  ];
  for (const s of data.sourceHealth) {
    lines.push(
      `| ${tableCell(s.name)} | ${tableCell(s.market)} | ${tableCell(s.lastPolledAt ?? "never")} | ` +
        `${tableCell(s.lastResultCount)} | ${tableCell(s.lastError)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Renders assembled digest data (see build.ts) as the markdown written to
 * `out/digest-YYYY-MM-DD.md`. Pure formatting — no DB access, no file I/O.
 */
export function renderDigestMarkdown(data: DigestData): string {
  const date = data.generatedAt.slice(0, 10);
  const sections: string[] = [`# Job Digest — ${date}`, ""];

  const alert = renderSourceAlerts(data);
  if (alert) sections.push(alert, "");

  sections.push(
    data.since === null
      ? `_First digest run — showing every open, scored posting._`
      : `_${data.totalNew} new posting(s) since the last digest (${data.since})._`,
  );
  sections.push("");

  if (data.totalNew === 0) {
    sections.push("No new postings since the last digest.", "");
  } else {
    for (const group of data.tierGroups) {
      if (group.entries.length === 0) continue;
      sections.push(`## ${TIER_LABELS[group.tier] ?? group.tier} (${group.entries.length})`, "");
      for (const entry of group.entries) {
        sections.push(renderEntry(entry), "");
      }
    }
  }

  const closingSoon = renderClosingSoon(data);
  if (closingSoon) sections.push(closingSoon, "");

  sections.push(renderSourceHealth(data), "");

  return sections.join("\n");
}
