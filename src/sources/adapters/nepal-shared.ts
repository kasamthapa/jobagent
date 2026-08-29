/**
 * Shared scraping utilities for Nepal adapters (portals + company careers
 * pages): a rate-limited HTML fetcher and a generic "find job-like links"
 * heuristic extractor. See CLAUDE.md's Nepal ingestion rules: a real
 * User-Agent, at most 1 request/sec against any one host, never parallel
 * against a host, and a selector matching zero elements is an ERROR (the
 * page loaded fine, our heuristic just found nothing) rather than an empty
 * result — callers are expected to throw when `extractJobCards` returns [].
 */

import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { createHash } from "node:crypto";

const USER_AGENT =
  "Mozilla/5.0 (compatible; jobagent/0.1; personal job-search tool; +https://github.com/)";

const MIN_INTERVAL_MS = 1000;
const lastRequestAtByHost = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits, if necessary, so this call lands at least MIN_INTERVAL_MS after the
 * last request to the same host. There's no queue here — Nepal sources are
 * always polled sequentially by cli.ts's poll loop, never concurrently — so
 * tracking one "last request time" per host is enough to enforce the 1
 * req/sec ceiling and guarantees no two requests to the same host overlap.
 */
async function throttle(host: string): Promise<void> {
  const last = lastRequestAtByHost.get(host);
  if (last !== undefined) {
    const wait = MIN_INTERVAL_MS - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }
  lastRequestAtByHost.set(host, Date.now());
}

/** Fetches `url` as HTML text, throttled to 1 req/sec per host. Throws with the URL and status on a non-2xx response. */
export async function fetchHtml(url: string): Promise<string> {
  await throttle(new URL(url).host);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} responded with HTTP ${res.status}`);
  }
  return res.text();
}

export interface ScrapedJobCard {
  externalId: string;
  title: string;
  url: string;
  description: string;
  companyName?: string;
  location?: string;
}

export interface ExtractOptions {
  /** Used as `companyName` when no company link can be guessed from the card (careers pages, where every posting belongs to the same company). */
  fallbackCompanyName?: string;
  /**
   * Nepal job *portals* conventionally embed a numeric id in every job
   * detail URL, which company/category/profile links on the same portal
   * don't share — requiring one filters those out. Single-company careers
   * pages rarely follow this convention (e.g. `/careers/frontend-developer`),
   * so it's off by default.
   */
  requireNumericId?: boolean;
  /**
   * Company marketing sites are mostly nav links to other sections of the
   * same site ("Platform", "Analytics", ...), which are just as
   * title-shaped as a real job title and have no numeric id to filter on
   * either. Restricts candidates to same-host links whose path itself
   * signals "this is a job" (contains "career", "job", "vacancy", ...) or
   * links hosted on a known ATS domain (the "this page just links out to
   * Greenhouse/Lever/etc." case) — on by default for careers pages, off for
   * portals, where every link on the page is job-related anyway and a
   * portal's own domain would trivially pass this check.
   */
  restrictToCareersPath?: boolean;
}

const KNOWN_ATS_HOST_SUBSTRINGS = [
  "greenhouse.io", "lever.co", "bamboohr.com", "workable.com",
  "recruitee.com", "breezy.hr", "smartrecruiters.com", "myworkdayjobs.com",
  "freshteam.com", "zohorecruit.com", "keka.com", "jobvite.com",
  "personio.com", "ashbyhq.com", "teamtailor.com", "hirehive.com",
];

function isKnownAtsHost(host: string): boolean {
  return KNOWN_ATS_HOST_SUBSTRINGS.some((s) => host.includes(s));
}

/**
 * A company's own careers page rarely nests every job under one fixed path
 * — e.g. Khalti's careers index lives at `/careers/` but its actual job
 * pages are at `/career-job/...`, a sibling, not a child, path. Keying off
 * "does this path look job-related at all" catches that case; it can't
 * perfectly separate an individual job page from a careers-section sub-page
 * that happens to share the same keyword (e.g. `/careers/what-we-do/`), but
 * that ambiguity is inherent to a *generic* heuristic, per CLAUDE.md.
 */
const JOB_PATH_KEYWORDS = ["career", "job", "vacan", "position", "opening", "hiring", "recruit", "opportunit"];

function looksLikeJobPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return JOB_PATH_KEYWORDS.some((k) => lower.includes(k));
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const NON_JOB_LABELS = new Set([
  "view detail", "view details", "view job", "job details", "apply now",
  "apply", "read more", "learn more", "see more", "details", "more details",
  "click here", "home", "about", "about us", "contact", "contact us",
  "login", "log in", "sign in", "register", "sign up", "next", "previous",
  "prev", "next page", "previous page", "privacy policy", "terms",
  "terms of service", "faq", "help", "search", "menu", "career", "careers",
  "jobs", "all jobs", "view all", "view all jobs", "browse jobs", "vacancies",
]);

/**
 * Careers pages are full of "come work with us" calls-to-action that are
 * exactly as title-shaped as a real job ("View Open Positions", "Join
 * Leapfrog", "Explore Opportunities") but aren't one — unlike NON_JOB_LABELS
 * (an exact-text list), these are matched as patterns since the CTA verb is
 * predictable but what follows it (the company/product name) isn't.
 */
const CTA_TEXT_PATTERNS = [
  /^join\b/, /^view\b/, /^see\b/, /^explore\b/, /^browse\b/, /^find\b/,
  /^apply\b/, /open positions?\b/, /current openings?\b/, /opportunit/,
];

function looksLikeCta(lowerText: string): boolean {
  return CTA_TEXT_PATTERNS.some((p) => p.test(lowerText));
}

const EXCLUDED_HREF_SUBSTRINGS = [
  "/login", "/register", "/signup", "/sign-up", "/about", "/contact",
  "/privacy", "/terms", "/faq", "/search", "/category/", "/tag/", "/page/",
  "facebook.com", "twitter.com", "x.com", "linkedin.com/share",
  "instagram.com", "youtube.com", "wa.me",
];

function isExcludedHref(href: string): boolean {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed === "#" ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:")
  ) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  return EXCLUDED_HREF_SUBSTRINGS.some((s) => lower.includes(s));
}

function isPlausibleTitle(text: string): boolean {
  if (!text) return false;
  if (text.length < 4 || text.length > 150) return false;
  const lower = text.toLowerCase();
  return !NON_JOB_LABELS.has(lower) && !looksLikeCta(lower);
}

function externalIdFromUrl(url: string): string {
  const digitRuns = new URL(url).pathname.match(/\d{3,}/g);
  if (digitRuns) return digitRuns[digitRuns.length - 1]!;
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

const KNOWN_LOCATIONS = [
  "kathmandu", "lalitpur", "bhaktapur", "pokhara", "biratnagar", "butwal",
  "chitwan", "dharan", "birgunj", "nepalgunj", "hetauda", "itahari",
  "work from home", "remote", "anywhere",
];

function guessLocation(containerText: string): string | undefined {
  const lower = containerText.toLowerCase();
  const hit = KNOWN_LOCATIONS.find((loc) => lower.includes(loc));
  return hit?.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Climbs from the title anchor up to (at most) 3 block ancestors looking
 * for one with enough text to plausibly be "the whole card" rather than
 * just the title itself — that's the scope searched for a company link and
 * used as the posting's description.
 */
function pickContainer($: cheerio.CheerioAPI, el: Element): cheerio.Cheerio<Element> {
  let node = $(el);
  for (let i = 0; i < 3; i++) {
    if (collapseWhitespace(node.text()).length > 40) break;
    const parent = node.parent();
    if (parent.length === 0 || parent.is("body") || parent.is("html")) break;
    node = parent;
  }
  return node;
}

/**
 * Looks for another link inside `container` that isn't a recognized job
 * link itself — the common "company name links to their profile" pattern.
 * `excludeUrls` is every URL already recognized as a job candidate (this
 * card's own, plus any sibling posting's) so that a container spanning
 * several cards — e.g. a shared `<ul>` wrapping every `<li>` — never picks
 * up a neighboring job's title as this card's "company".
 */
function guessCompanyName(
  $: cheerio.CheerioAPI,
  container: cheerio.Cheerio<Element>,
  baseUrl: string,
  excludeUrls: ReadonlySet<string>,
): string | undefined {
  let found: string | undefined;
  container.find("a[href]").each((_, a) => {
    if (found) return;
    const href = $(a).attr("href");
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (excludeUrls.has(resolved.toString())) return;
    const text = collapseWhitespace($(a).text());
    if (text.length >= 2 && text.length <= 80 && !NON_JOB_LABELS.has(text.toLowerCase())) {
      found = text;
    }
  });
  return found;
}

/**
 * Generic "find job-like links" heuristic shared by every Nepal adapter:
 * every `<a>` in the document is a candidate; anchors pointing at nav/legal/
 * social chrome are excluded by href, anchors whose visible text is a
 * generic label ("Apply Now", "Home", ...) or clearly not title-shaped are
 * excluded by text, and whatever survives is treated as one job link per
 * distinct resolved URL (a title link and a "View Details" link pointing at
 * the same job collapse into one card, keeping the longer/title-shaped
 * text). Returns `[]` when nothing survives — callers must treat that as an
 * error, per CLAUDE.md, not an empty result.
 */
export function extractJobCards(html: string, baseUrl: string, opts: ExtractOptions = {}): ScrapedJobCard[] {
  const $ = cheerio.load(html);
  const candidates = new Map<string, { title: string; el: Element }>();
  const base = new URL(baseUrl);

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (!href || isExcludedHref(href)) return;

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    // A link back to the very page being scraped (possibly with a #fragment,
    // e.g. a "Join Us" button that just scrolls to an empty/JS-filled
    // section) is never a distinct job posting.
    if (resolved.origin === base.origin && resolved.pathname === base.pathname && resolved.search === base.search) {
      return;
    }
    if (opts.requireNumericId && !/\d{3,}/.test(resolved.pathname)) return;
    if (opts.restrictToCareersPath) {
      const sameHostJobPath = resolved.host === base.host && looksLikeJobPath(resolved.pathname);
      if (!sameHostJobPath && !isKnownAtsHost(resolved.host)) return;
    }

    const text = collapseWhitespace($el.text()) || collapseWhitespace($el.find("h1,h2,h3,h4,h5").first().text());
    if (!isPlausibleTitle(text)) return;

    const key = resolved.toString();
    const existing = candidates.get(key);
    if (!existing || text.length > existing.title.length) {
      candidates.set(key, { title: text, el });
    }
  });

  const candidateUrls = new Set(candidates.keys());
  const cards: ScrapedJobCard[] = [];
  for (const [url, { title, el }] of candidates) {
    const container = pickContainer($, el);
    const containerText = collapseWhitespace(container.text());
    const card: ScrapedJobCard = {
      externalId: externalIdFromUrl(url),
      title,
      url,
      description: containerText.length > title.length ? containerText : title,
    };
    const companyName = guessCompanyName($, container, baseUrl, candidateUrls) ?? opts.fallbackCompanyName;
    if (companyName) card.companyName = companyName;
    const location = guessLocation(containerText);
    if (location) card.location = location;
    cards.push(card);
  }
  return cards;
}

/** "leapfrog-technology" -> "Leapfrog Technology" — for careers-page sources, whose registry `name` is the only company name on hand. */
export function prettifyName(slug: string): string {
  return slug
    .split("-")
    .map((word) => (word.length ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}
