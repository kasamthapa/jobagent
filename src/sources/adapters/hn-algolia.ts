import { z } from "zod";
import type { JobSource, RawPosting, Source } from "../types.js";
import { fetchJson, htmlToText, makeRawPosting } from "./shared.js";

const searchResponseSchema = z.object({
  hits: z.array(z.object({ objectID: z.string() })),
});

const commentSchema = z.object({
  id: z.number(),
  author: z.string().nullable(),
  text: z.string().nullable(),
  created_at: z.string().optional(),
});

const itemResponseSchema = z.object({
  children: z.array(commentSchema),
});

/**
 * HN "Who is Hiring" comments have no structured title field, but most
 * authors write one plain-text summary line — commonly
 * "Company | Location | Role" — before the first HTML paragraph of body
 * copy. Ordering of that pipe-delimited line isn't consistent enough across
 * authors to reliably pick out "the role" alone (see logs/decisions.md), so
 * the whole line is used verbatim as the title; comments with no such line
 * fall back to the start of the body text.
 */
function splitHeader(rawText: string): { header: string; body: string } {
  const idx = rawText.search(/<p[\s>]/i);
  if (idx <= 0) return { header: "", body: rawText };
  return { header: rawText.slice(0, idx), body: rawText.slice(idx) };
}

function buildUrl(base: string): (path: string) => string {
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  return (path) => `${withSlash}${path}`;
}

/**
 * https://hn.algolia.com/api/v1/ — two-step: find the latest monthly "Who
 * is hiring?" thread via search, then fetch its top-level comments (each
 * one is a candidate job posting). Nested replies are discussion, not
 * postings, and are ignored.
 */
export const hnAlgoliaAdapter: JobSource = {
  name: "hn-algolia",
  market: "remote",
  kind: "api",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("hn-algolia: source has no url configured");
    const url = buildUrl(source.url);

    const searchRaw = await fetchJson(
      url("search_by_date?tags=story,author_whoishiring&query=Who%20is%20Hiring"),
    );
    const search = searchResponseSchema.parse(searchRaw);
    const storyId = search.hits[0]?.objectID;
    if (!storyId) {
      throw new Error("hn-algolia: no 'Who is hiring' thread found");
    }

    const itemRaw = await fetchJson(url(`items/${storyId}`));
    const item = itemResponseSchema.parse(itemRaw);

    const postings: RawPosting[] = [];
    for (const comment of item.children) {
      if (!comment.text || !comment.author) continue; // deleted/flagged comments
      const { header, body } = splitHeader(comment.text);
      const headerText = htmlToText(header).trim();
      const bodyText = htmlToText(body).trim();
      const description = headerText ? `${headerText}\n${bodyText}` : bodyText;
      const title = (headerText || bodyText).slice(0, 140) || "HN Who is Hiring posting";
      postings.push(
        makeRawPosting(
          {
            externalId: String(comment.id),
            title,
            description,
            url: `https://news.ycombinator.com/item?id=${comment.id}`,
          },
          {
            postedAt: comment.created_at,
          },
        ),
      );
    }
    return postings;
  },
};
