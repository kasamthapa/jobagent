import type { JobSource, RawPosting, Source } from "../types.js";
import { makeRawPosting } from "./shared.js";
import { extractJobCards, fetchHtml, prettifyName } from "./nepal-shared.js";

/**
 * Generic heuristic extractor for Nepal company careers pages (Phase 3).
 * These pages vary wildly in structure — some list openings directly with
 * per-role links, others are just a "reach out to apply" page with no
 * per-role links at all. Unlike the portal adapters, careers-page job links
 * rarely embed a numeric id (e.g. `/careers/frontend-developer`), so
 * `requireNumericId` is left off; `companyName` falls back to the
 * registry's own `source.name` since every posting on a company's own page
 * is, obviously, from that company.
 */
export const careersGenericAdapter: JobSource = {
  name: "careers-generic",
  market: "nepal",
  kind: "careers",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("careers-generic: source has no url configured");
    const html = await fetchHtml(source.url);
    const cards = extractJobCards(html, source.url, {
      fallbackCompanyName: prettifyName(source.name),
      restrictToCareersPath: true,
    });
    if (cards.length === 0) {
      throw new Error(`careers-generic: selector matched 0 job listings on ${source.url} (${source.name})`);
    }

    return cards.map((card) =>
      makeRawPosting(
        { externalId: card.externalId, title: card.title, description: card.description, url: card.url },
        { companyName: card.companyName, location: card.location },
      ),
    );
  },
};
