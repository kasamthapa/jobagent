import type { JobSource, RawPosting, Source } from "../types.js";
import { makeRawPosting } from "./shared.js";
import { extractJobCards, fetchHtml } from "./nepal-shared.js";

/**
 * https://jobaxle.com — Nepal IT-focused job portal. The configured URL is
 * the homepage (per `data/sources.json`, seeded in Phase 1), which mostly
 * shows category links rather than a job list — the heuristic extractor may
 * find nothing there, logged as a source error rather than crashing the
 * poll (see CLAUDE.md).
 */
export const jobaxleAdapter: JobSource = {
  name: "jobaxle",
  market: "nepal",
  kind: "portal",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("jobaxle: source has no url configured");
    const html = await fetchHtml(source.url);
    const cards = extractJobCards(html, source.url, { requireNumericId: true });
    if (cards.length === 0) {
      throw new Error(`jobaxle: selector matched 0 job listings on ${source.url}`);
    }

    return cards.map((card) =>
      makeRawPosting(
        { externalId: card.externalId, title: card.title, description: card.description, url: card.url },
        { companyName: card.companyName, location: card.location },
      ),
    );
  },
};
