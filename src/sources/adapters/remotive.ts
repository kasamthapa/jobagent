import { z } from "zod";
import type { JobSource, RawPosting, Source } from "../types.js";
import { fetchJson, htmlToText, inferLocationPolicy, makeRawPosting } from "./shared.js";

const remotiveJobSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  url: z.string(),
  title: z.string(),
  company_name: z.string(),
  publication_date: z.string().optional(),
  candidate_required_location: z.string().optional(),
  salary: z.string().optional(),
  description: z.string(),
});

const remotiveResponseSchema = z.object({
  jobs: z.array(remotiveJobSchema),
});

/** https://remotive.com/api/remote-jobs — public JSON API, no auth. */
export const remotiveAdapter: JobSource = {
  name: "remotive",
  market: "remote",
  kind: "api",
  async fetch(source: Source): Promise<RawPosting[]> {
    if (!source.url) throw new Error("remotive: source has no url configured");
    const raw = await fetchJson(source.url);
    const parsed = remotiveResponseSchema.parse(raw);

    return parsed.jobs.map((job) =>
      makeRawPosting(
        {
          externalId: job.id,
          title: job.title,
          description: htmlToText(job.description),
          url: job.url,
        },
        {
          companyName: job.company_name,
          location: job.candidate_required_location,
          locationPolicy: inferLocationPolicy(job.candidate_required_location),
          salaryText: job.salary || undefined,
          postedAt: job.publication_date,
        },
      ),
    );
  },
};
