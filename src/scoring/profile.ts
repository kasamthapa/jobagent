import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Profile } from "./types.js";

const profileSchema = z.object({
  solid: z.array(z.string().min(1)),
  working: z.array(z.string().min(1)),
  learning: z.array(z.string().min(1)),
  next: z.array(z.string().min(1)),
  constraints: z.object({
    location: z.string().min(1),
    workVisa: z.boolean(),
    eligibility: z.string().min(1),
    level: z.string().min(1),
  }),
}) satisfies z.ZodType<Profile>;

export const DEFAULT_PROFILE_PATH = "data/profile.json";

/**
 * Loads and validates the owner profile from disk. Throws a descriptive zod
 * error if malformed — this is meant to fail loudly at `score` time rather
 * than silently score against a broken/partial profile.
 */
export function loadProfile(path: string = DEFAULT_PROFILE_PATH): Profile {
  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return profileSchema.parse(parsed);
}
