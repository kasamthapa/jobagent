import type { JobSource, RawPosting, Source } from "../types.js";
import { makeRawPosting } from "./shared.js";
import { extractJobCards, fetchHtml } from "./nepal-shared.js";

/**
 * https://merojob.com — Nepal's largest general job portal. Its category
 * pages render listings via client-side JS on top of a mostly-static shell,
 * so the generic heuristic extractor may legitimately find nothing here;
 * that's logged as a source error (per CLAUDE.md) rather than crashing the
 * whole poll.
 */
export const merojobAdapter: JobSource = {
  name: "merojob",
  market: "nepal",
  kind: "portal",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("merojob: source has no url configured");
    const html = await fetchHtml(source.url);
    const cards = extractJobCards(html, source.url, { requireNumericId: true });
    if (cards.length === 0) {
      throw new Error(`merojob: selector matched 0 job listings on ${source.url}`);
    }

    return cards.map((card) =>
      makeRawPosting(
        { externalId: card.externalId, title: card.title, description: card.description, url: card.url },
        { companyName: card.companyName, location: card.location },
      ),
    );
  },
};
