import type { JobSource, RawPosting, Source } from "../types.js";
import { makeRawPosting } from "./shared.js";
import { extractJobCards, fetchHtml } from "./nepal-shared.js";

/**
 * https://merojob.com — Nepal's largest general job portal. Confirmed
 * 2026-09: its category pages (e.g. /category/it-telecommunication) now
 * render listings entirely via client-side JS — 0 job links in the static
 * HTML. The homepage does server-render a real "latest jobs" feed, but it
 * isn't filterable to IT roles, so this source is deactivated in
 * data/sources.json (see its "note") rather than pointed there. The code
 * below is unchanged and still correct for any page that does have a
 * server-rendered listing; it's the currently-configured URL that no
 * longer has one. A 0-match result is logged as a source error (per
 * CLAUDE.md) rather than crashing the whole poll.
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
