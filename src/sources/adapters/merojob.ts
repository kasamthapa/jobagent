import type { JobSource, RawPosting, Source } from "../types.js";
import { makeRawPosting } from "./shared.js";
import { extractJobCards, fetchHtml } from "./nepal-shared.js";

/**
 * https://merojob.com — Nepal's largest general job portal. Confirmed
 * 2026-09: its category pages (e.g. /category/it-telecommunication) now
 * render listings entirely via client-side JS — 0 job links in the static
 * HTML. The homepage does server-render a real "latest jobs" feed, so
 * `data/sources.json` points this source there instead. That feed isn't
 * filtered to IT roles (it's every category mixed together) — deliberately
 * left unfiltered rather than chasing a hidden category-filtered SSR
 * endpoint; the Phase 4 prefilter/scorer handle the noise downstream, the
 * same way they already handle the HN "Who's Hiring" firehose from Phase 2.
 * A 0-match result is still logged as a source error (per CLAUDE.md) rather
 * than crashing the whole poll, in case the homepage ever stops
 * server-rendering too.
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
