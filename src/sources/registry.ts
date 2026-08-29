import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Source } from "./types.js";

const sourceSchema = z.object({
  name: z.string().min(1),
  market: z.enum(["nepal", "remote"]),
  kind: z.enum(["portal", "careers", "api", "rss", "ats"]),
  url: z.string().url().nullable(),
  adapter: z.string().min(1),
  active: z.boolean(),
}) satisfies z.ZodType<Source>;

const registrySchema = z.array(sourceSchema);

export const DEFAULT_REGISTRY_PATH = "data/sources.json";

/**
 * Loads and validates the source registry from disk. Throws a descriptive
 * zod error if any entry is malformed — this is meant to fail loudly at
 * `init` time rather than silently skip a broken source.
 */
export function loadRegistry(path: string = DEFAULT_REGISTRY_PATH): Source[] {
  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return registrySchema.parse(parsed);
}
