import { z } from "zod";
import type { JobSource, LocationPolicy, RawPosting, Source } from "../types.js";
import { fetchJson, htmlToText, inferLocationPolicy, makeRawPosting } from "./shared.js";

const arbeitnowJobSchema = z.object({
  slug: z.string(),
  company_name: z.string(),
  title: z.string(),
  description: z.string(),
  remote: z.boolean(),
  url: z.string(),
  location: z.string().optional(),
  created_at: z.number().optional(),
});

const arbeitnowResponseSchema = z.object({
  data: z.array(arbeitnowJobSchema),
});

/**
 * A posting that isn't remote is region-locked to wherever it's based,
 * regardless of what its `location` text says; a remote one falls back to
 * the usual "does it name a specific place" heuristic.
 */
function policyFor(remote: boolean, location: string | undefined): LocationPolicy {
  return remote ? inferLocationPolicy(location) : "region_locked";
}

/** https://www.arbeitnow.com/api/job-board-api — public JSON API, no auth. */
export const arbeitnowAdapter: JobSource = {
  name: "arbeitnow",
  market: "remote",
  kind: "api",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("arbeitnow: source has no url configured");
    const raw = await fetchJson(source.url);
    const parsed = arbeitnowResponseSchema.parse(raw);

    return parsed.data.map((job) =>
      makeRawPosting(
        {
          externalId: job.slug,
          title: job.title,
          description: htmlToText(job.description),
          url: job.url,
        },
        {
          companyName: job.company_name,
          location: job.location,
          locationPolicy: policyFor(job.remote, job.location),
          postedAt: job.created_at !== undefined ? new Date(job.created_at * 1000).toISOString() : undefined,
        },
      ),
    );
  },
};
