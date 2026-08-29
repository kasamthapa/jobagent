import type { JobSource } from "../types.js";
import { remotiveAdapter } from "./remotive.js";
import { arbeitnowAdapter } from "./arbeitnow.js";
import { remoteokAdapter } from "./remoteok.js";
import { himalayasAdapter } from "./himalayas.js";
import { weworkremotelyAdapter } from "./weworkremotely.js";
import { hnAlgoliaAdapter } from "./hn-algolia.js";
import { merojobAdapter } from "./merojob.js";
import { kumarijobAdapter } from "./kumarijob.js";
import { jobsnepalAdapter } from "./jobsnepal.js";
import { jobaxleAdapter } from "./jobaxle.js";
import { careersGenericAdapter } from "./careers-generic.js";

/** Maps `sources.adapter` (from data/sources.json) to its implementation. */
export const adapters: Record<string, JobSource> = {
  remotive: remotiveAdapter,
  arbeitnow: arbeitnowAdapter,
  remoteok: remoteokAdapter,
  himalayas: himalayasAdapter,
  "weworkremotely-rss": weworkremotelyAdapter,
  "hn-algolia": hnAlgoliaAdapter,
  merojob: merojobAdapter,
  kumarijob: kumarijobAdapter,
  jobsnepal: jobsnepalAdapter,
  jobaxle: jobaxleAdapter,
  "careers-generic": careersGenericAdapter,
};
