import type { PostingRow } from "../db/queries.js";

export interface DedupeGroup {
  dedupeKey: string;
  /** The posting shown as the canonical entry for this job — whichever source has the richest (longest) description. */
  canonical: PostingRow;
  /** Earliest first_seen_at across every posting sharing this dedupe_key — when the job was truly first seen, regardless of which source wrote it up best. */
  firstSeenAt: string;
  /** Every other posting sharing this dedupe_key, so the digest can link out to all of them. */
  alternates: PostingRow[];
}

/**
 * Collapses postings sharing a `dedupe_key` (the same job posted on
 * multiple portals) into one group each. This is a read-time view over the
 * `postings` table, not a destructive merge — every row stays in the DB
 * untouched; the digest (Phase 5) uses `canonical` for the main entry and
 * `alternates` for the "also posted on" links.
 */
export function computeDedupeGroups(postings: PostingRow[]): DedupeGroup[] {
  const byKey = new Map<string, PostingRow[]>();
  for (const posting of postings) {
    const members = byKey.get(posting.dedupe_key);
    if (members) members.push(posting);
    else byKey.set(posting.dedupe_key, [posting]);
  }

  const groups: DedupeGroup[] = [];
  for (const [dedupeKey, members] of byKey) {
    const canonical = members.reduce((richest, candidate) =>
      (candidate.description?.length ?? 0) > (richest.description?.length ?? 0) ? candidate : richest,
    );
    const firstSeenAt = members.reduce(
      (earliest, m) => (m.first_seen_at < earliest ? m.first_seen_at : earliest),
      members[0]!.first_seen_at,
    );
    const alternates = members.filter((m) => m.id !== canonical.id);
    groups.push({ dedupeKey, canonical, firstSeenAt, alternates });
  }
  return groups;
}

/** Total postings collapsed away as duplicates — i.e. every group member that isn't its group's canonical posting. */
export function countDuplicates(groups: DedupeGroup[]): number {
  return groups.reduce((sum, g) => sum + g.alternates.length, 0);
}
