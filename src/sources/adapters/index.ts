import type { JobSource } from "../types.js";
import { remotiveAdapter } from "./remotive.js";
import { arbeitnowAdapter } from "./arbeitnow.js";
import { remoteokAdapter } from "./remoteok.js";
import { himalayasAdapter } from "./himalayas.js";
import { weworkremotelyAdapter } from "./weworkremotely.js";
import { hnAlgoliaAdapter } from "./hn-algolia.js";

/**
 * Maps `sources.adapter` (from data/sources.json) to its implementation.
 * Nepal adapters (Phase 3) aren't registered here yet — cli.ts's poll
 * command skips any source whose adapter name has no entry.
 */
export const adapters: Record<string, JobSource> = {
  remotive: remotiveAdapter,
  arbeitnow: arbeitnowAdapter,
  remoteok: remoteokAdapter,
  himalayas: himalayasAdapter,
  "weworkremotely-rss": weworkremotelyAdapter,
  "hn-algolia": hnAlgoliaAdapter,
};
