import type { JobSource, RawPosting, Source } from "../types.js";
import { makeRawPosting } from "./shared.js";
import { extractJobCards, fetchHtml } from "./nepal-shared.js";

/**
 * https://www.jobsnepal.com — Nepal job portal covering all sectors; the IT
 * category page lists a small set of dedicated IT postings plus a broader
 * "Top Jobs" sidebar. Company names here are often plain text rather than a
 * link to a profile page, so `companyName` comes back unset more often than
 * on portals that link every company (see `nepal-shared.ts`'s
 * `guessCompanyName`, which only recognizes the linked-company pattern).
 */
export const jobsnepalAdapter: JobSource = {
  name: "jobsnepal",
  market: "nepal",
  kind: "portal",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("jobsnepal: source has no url configured");
    const html = await fetchHtml(source.url);
    const cards = extractJobCards(html, source.url, { requireNumericId: true });
    if (cards.length === 0) {
      throw new Error(`jobsnepal: selector matched 0 job listings on ${source.url}`);
    }

    return cards.map((card) =>
      makeRawPosting(
        { externalId: card.externalId, title: card.title, description: card.description, url: card.url },
        { companyName: card.companyName, location: card.location },
      ),
    );
  },
};
