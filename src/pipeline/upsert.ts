import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Market, RawPosting } from "../sources/types.js";
import { closeStalePostings, getOrCreateCompany, upsertPosting } from "../db/queries.js";

/** sha256(title + description) — used to skip re-scoring an unchanged posting (Phase 4). */
export function computeContentHash(title: string, description: string): string {
  return createHash("sha256").update(`${title}\n${description}`).digest("hex");
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** normalized(company + title) — collapses the same job posted on multiple portals. */
export function computeDedupeKey(companyName: string | undefined, title: string): string {
  return `${normalize(companyName ?? "unknown")}::${normalize(title)}`;
}

export interface ApplyPollResult {
  inserted: number;
  updated: number;
  closed: number;
}

/**
 * Applies one successful poll of `source` to the DB: upserts every posting
 * by (source_id, external_id), computing content_hash/dedupe_key along the
 * way, then closes (is_open = 0) any posting for that source not present
 * in this batch. Only call this after a successful fetch — a failed fetch
 * must never close postings that simply weren't re-fetched this time.
 */
export function applyPoll(
  db: Database.Database,
  sourceId: number,
  market: Market,
  postings: RawPosting[],
  now: string = new Date().toISOString(),
): ApplyPollResult {
  let inserted = 0;
  let updated = 0;
  const seenExternalIds: string[] = [];

  for (const posting of postings) {
    seenExternalIds.push(posting.externalId);
    const companyId = posting.companyName
      ? getOrCreateCompany(db, posting.companyName, market)
      : null;

    const { isNew } = upsertPosting(db, {
      sourceId,
      companyId,
      externalId: posting.externalId,
      title: posting.title,
      description: posting.description,
      url: posting.url,
      location: posting.location ?? null,
      locationPolicy: posting.locationPolicy ?? "unknown",
      timezoneRequirement: posting.timezoneRequirement ?? null,
      salaryText: posting.salaryText ?? null,
      postedAt: posting.postedAt ?? null,
      deadline: posting.deadline ?? null,
      contentHash: computeContentHash(posting.title, posting.description),
      dedupeKey: computeDedupeKey(posting.companyName, posting.title),
      now,
    });
    if (isNew) inserted++;
    else updated++;
  }

  const closed = closeStalePostings(db, sourceId, seenExternalIds);
  return { inserted, updated, closed };
}
