import * as cheerio from "cheerio";
import { z } from "zod";
import type { JobSource, RawPosting, Source } from "../types.js";
import { fetchText, htmlToText, inferLocationPolicy, makeRawPosting } from "./shared.js";

const itemSchema = z.object({
  guid: z.string().min(1),
  title: z.string().min(1),
  link: z.string().min(1),
});

/** WWR titles are "Company: Job Title" — split on the first colon. */
function splitTitle(rawTitle: string): { company: string | undefined; title: string } {
  const index = rawTitle.indexOf(":");
  if (index === -1) return { company: undefined, title: rawTitle.trim() };
  const company = rawTitle.slice(0, index).trim();
  const title = rawTitle.slice(index + 1).trim();
  return { company: company || undefined, title: title || rawTitle.trim() };
}

function parseDate(text: string): string | undefined {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** https://weworkremotely.com/categories/remote-programming-jobs.rss — public RSS 2.0 feed. */
export const weworkremotelyAdapter: JobSource = {
  name: "weworkremotely-rss",
  market: "remote",
  kind: "rss",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("weworkremotely: source has no url configured");
    const xml = await fetchText(source.url);
    const $ = cheerio.load(xml, { xmlMode: true });

    if ($("channel").length === 0) {
      throw new Error("weworkremotely: response has no <channel> — not an RSS feed");
    }

    const postings: RawPosting[] = [];
    $("item").each((_, el) => {
      const $el = $(el);
      const rawTitle = $el.find("title").first().text().trim();
      const link = $el.find("link").first().text().trim();
      const guid = $el.find("guid").first().text().trim() || link;
      const region = $el.find("region").first().text().trim();
      const pubDate = $el.find("pubDate").first().text().trim();
      const descriptionHtml = $el.find("description").first().text();

      const item = itemSchema.safeParse({ guid, title: rawTitle, link });
      if (!item.success) return; // skip malformed entries rather than aborting the whole feed

      const { company, title } = splitTitle(item.data.title);
      postings.push(
        makeRawPosting(
          {
            externalId: item.data.guid,
            title,
            description: htmlToText(descriptionHtml),
            url: item.data.link,
          },
          {
            companyName: company,
            location: region || undefined,
            locationPolicy: inferLocationPolicy(region),
            postedAt: pubDate ? parseDate(pubDate) : undefined,
          },
        ),
      );
    });

    return postings;
  },
};
