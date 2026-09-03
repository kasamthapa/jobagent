/**
 * Helpers shared by every remote adapter: a fetch wrapper with a real
 * User-Agent (some APIs, e.g. RemoteOK, 403 the default Node UA), HTML ->
 * plain text for descriptions, and the "does this posting name a specific
 * region" heuristic used to infer `location_policy`.
 */

import * as cheerio from "cheerio";
import type { LocationPolicy, RawPosting } from "../types.js";
import { fetchWithRetry, type FetchRetryOptions } from "../../net/http.js";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; jobagent/0.1; personal job-search tool; +https://github.com/)",
  Accept: "application/json, application/xml, text/xml, */*",
};

/**
 * Fetches `url` and parses the body as JSON. Retries once with backoff on a
 * timeout, network error, or 429/5xx response (see net/http.ts); throws with
 * the URL and status if the final attempt is still non-2xx.
 */
export async function fetchJson(url: string, opts?: FetchRetryOptions): Promise<unknown> {
  const res = await fetchWithRetry(url, { headers: DEFAULT_HEADERS }, opts);
  if (!res.ok) {
    throw new Error(`GET ${url} responded with HTTP ${res.status}`);
  }
  return res.json();
}

/** Fetches `url` and returns the raw body text (used for RSS/XML feeds). Same retry behavior as `fetchJson`. */
export async function fetchText(url: string, opts?: FetchRetryOptions): Promise<string> {
  const res = await fetchWithRetry(url, { headers: DEFAULT_HEADERS }, opts);
  if (!res.ok) {
    throw new Error(`GET ${url} responded with HTTP ${res.status}`);
  }
  return res.text();
}

/** Strips HTML tags and collapses whitespace, for descriptions that arrive as HTML fragments. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  return $.root().text().replace(/\s+/g, " ").trim();
}

const WORLDWIDE_HINTS = ["world", "anywhere", "global", "remote - global"];

/**
 * Infers `location_policy` from a source's free-text location/region field.
 * No text stated at all means the posting doesn't claim a restriction, so
 * it defaults to worldwide; any specific country/region named is treated
 * as a restriction (`region_locked`) even if it lists several regions,
 * since "Europe, USA, Canada" still excludes Nepal.
 */
export function inferLocationPolicy(text: string | null | undefined): LocationPolicy {
  if (!text || !text.trim()) return "worldwide";
  const normalized = text.toLowerCase();
  if (WORLDWIDE_HINTS.some((hint) => normalized.includes(hint))) return "worldwide";
  return "region_locked";
}

/**
 * Unlike RawPosting's own optional fields (plain `field?: T`, which under
 * `exactOptionalPropertyTypes` forbids ever assigning `undefined` to them),
 * every field here explicitly allows `T | undefined` — that's exactly the
 * shape adapters have on hand (e.g. `job.salary || undefined`) before
 * `makeRawPosting` below decides which keys are worth setting at all.
 */
interface RawPostingOptional {
  companyName?: string | undefined;
  location?: string | undefined;
  locationPolicy?: LocationPolicy | undefined;
  timezoneRequirement?: string | undefined;
  salaryText?: string | undefined;
  postedAt?: string | undefined;
  deadline?: string | undefined;
}

/**
 * Builds a RawPosting from its required fields plus a bag of optional ones,
 * assigning each optional key only when defined. `tsconfig.json` has
 * `exactOptionalPropertyTypes` on, so `{ location: maybeUndefinedString }`
 * doesn't typecheck against `location?: string` — every adapter needs this
 * same "assign only if present" dance, hence one shared helper.
 */
export function makeRawPosting(
  required: Pick<RawPosting, "externalId" | "title" | "description" | "url">,
  optional: RawPostingOptional,
): RawPosting {
  const posting: RawPosting = { ...required };
  for (const key of Object.keys(optional) as (keyof RawPostingOptional)[]) {
    const value = optional[key];
    if (value !== undefined) {
      (posting as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return posting;
}
