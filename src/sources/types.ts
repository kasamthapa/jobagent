/**
 * Shared types for the source registry and adapters.
 *
 * `nepal` sources are scraped HTML (portals + company careers pages).
 * `remote` sources are real JSON/RSS APIs. See CLAUDE.md for the full
 * two-market distinction.
 */

export type Market = "nepal" | "remote";

export type SourceKind = "portal" | "careers" | "api" | "rss" | "ats";

export type LocationPolicy = "worldwide" | "region_locked" | "unknown";

export type Tier = "safe" | "stretch" | "reach" | "no";

/** A configured source, as loaded from data/sources.json into the `sources` table. */
export interface Source {
  name: string;
  market: Market;
  kind: SourceKind;
  /** null when the source's URL could not be verified (see logs/decisions.md). */
  url: string | null;
  adapter: string;
  active: boolean;
}

/** A job posting as produced by an adapter, before it is upserted into `postings`. */
export interface RawPosting {
  externalId: string;
  title: string;
  description: string;
  url: string;
  companyName?: string;
  location?: string;
  locationPolicy?: LocationPolicy;
  /** Free text, e.g. "US business hours" or "GMT-5 to GMT+1", when the posting states one. */
  timezoneRequirement?: string;
  salaryText?: string;
  /** ISO 8601 date/datetime, when the source provides one. */
  postedAt?: string;
  /** ISO 8601 date/datetime, when the source states an application deadline. */
  deadline?: string;
}

/**
 * Contract every adapter under src/sources/adapters/ implements.
 * Phase 1 defines this interface only; Phase 2 (remote) and Phase 3 (Nepal)
 * provide the implementations. Every adapter needs a vitest test.
 */
export interface JobSource {
  name: string;
  market: Market;
  kind: SourceKind;
  fetch(source: Source): Promise<RawPosting[]>;
}
