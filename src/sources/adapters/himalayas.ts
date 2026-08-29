import { z } from "zod";
import type { JobSource, RawPosting, Source } from "../types.js";
import { fetchJson, htmlToText, makeRawPosting } from "./shared.js";

const himalayasJobSchema = z.object({
  guid: z.string(),
  title: z.string(),
  description: z.string().optional().default(""),
  companyName: z.string(),
  applicationLink: z.string(),
  pubDate: z.number().optional(),
  locationRestrictions: z.array(z.string()).optional().default([]),
  timezoneRestrictions: z.array(z.number()).optional().default([]),
  // The live API sends explicit `null` (not just omission) when salary isn't disclosed.
  minSalary: z.number().nullable().optional(),
  maxSalary: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
});

const himalayasResponseSchema = z.object({
  jobs: z.array(himalayasJobSchema),
});

function salaryText(job: z.infer<typeof himalayasJobSchema>): string | undefined {
  const min = job.minSalary ?? undefined;
  const max = job.maxSalary ?? undefined;
  if (min === undefined && max === undefined) return undefined;
  const currency = job.currency ?? "";
  if (min !== undefined && max !== undefined) {
    return `${currency} ${min}-${max}`.trim();
  }
  return `${currency} ${min ?? max}`.trim();
}

function timezoneText(offsets: number[]): string | undefined {
  if (offsets.length === 0) return undefined;
  return offsets
    .slice()
    .sort((a, b) => a - b)
    .map((offset) => `UTC${offset >= 0 ? "+" : ""}${offset}`)
    .join(", ");
}

/** https://himalayas.app/jobs/api — public JSON API, no auth. */
export const himalayasAdapter: JobSource = {
  name: "himalayas",
  market: "remote",
  kind: "api",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("himalayas: source has no url configured");
    const raw = await fetchJson(source.url);
    const parsed = himalayasResponseSchema.parse(raw);

    return parsed.jobs.map((job) =>
      makeRawPosting(
        {
          externalId: job.guid,
          title: job.title,
          description: htmlToText(job.description),
          url: job.applicationLink,
        },
        {
          companyName: job.companyName,
          location: job.locationRestrictions.join(", ") || undefined,
          // Himalayas states restrictions explicitly rather than an open location field:
          // no restriction listed means worldwide, any listed country means region-locked.
          locationPolicy: job.locationRestrictions.length === 0 ? "worldwide" : "region_locked",
          timezoneRequirement: timezoneText(job.timezoneRestrictions),
          salaryText: salaryText(job),
          postedAt: job.pubDate !== undefined ? new Date(job.pubDate * 1000).toISOString() : undefined,
        },
      ),
    );
  },
};
