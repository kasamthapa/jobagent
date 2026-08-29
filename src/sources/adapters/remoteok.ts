import { z } from "zod";
import type { JobSource, RawPosting, Source } from "../types.js";
import { fetchJson, htmlToText, inferLocationPolicy, makeRawPosting } from "./shared.js";

const remoteokJobSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  position: z.string(),
  company: z.string(),
  description: z.string().optional().default(""),
  url: z.string(),
  location: z.string().optional(),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  date: z.string().optional(),
});

/**
 * RemoteOK's array starts with a legal-notice object that has neither
 * `id` nor `position` — filter it (and anything else shaped like it) out
 * before validating the rest as job postings.
 */
function isJobEntry(item: unknown): item is Record<string, unknown> {
  return typeof item === "object" && item !== null && "id" in item && "position" in item;
}

function salaryText(min: number | undefined, max: number | undefined): string | undefined {
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined) return `$${min} - $${max}`;
  return `$${min ?? max}`;
}

/** https://remoteok.com/api — public JSON API; requires a browser-like User-Agent or it 403s. */
export const remoteokAdapter: JobSource = {
  name: "remoteok",
  market: "remote",
  kind: "api",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("remoteok: source has no url configured");
    const raw = await fetchJson(source.url);
    const array = z.array(z.unknown()).parse(raw);
    const jobs = array.filter(isJobEntry).map((item) => remoteokJobSchema.parse(item));

    return jobs.map((job) =>
      makeRawPosting(
        {
          externalId: job.id,
          title: job.position,
          description: htmlToText(job.description),
          url: job.url,
        },
        {
          companyName: job.company,
          location: job.location,
          locationPolicy: inferLocationPolicy(job.location),
          salaryText: salaryText(job.salary_min, job.salary_max),
          postedAt: job.date,
        },
      ),
    );
  },
};
