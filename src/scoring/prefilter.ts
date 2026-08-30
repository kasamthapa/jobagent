import type { LocationPolicy, Market } from "../sources/types.js";
import type { PrefilterResult } from "./types.js";

/**
 * Cheap, LLM-free pass over every posting before it costs a Gemini call:
 * drop obviously-senior titles, drop roles that aren't engineering at all,
 * and drop remote roles whose location_policy names a region (region_locked
 * always excludes Nepal — see the shared adapter heuristic's decision log).
 * Nepal-market postings are never dropped on location_policy; that
 * eligibility concern only applies to remote sources (CLAUDE.md).
 */

const SENIOR_TITLE_PATTERN =
  /\b(senior|sr\.?|lead|principal|staff|manager|director|head of|vp|chief|architect)\b/i;

const NON_ENGINEERING_PATTERN =
  /\b(sales|marketing|account executive|business development|human resources|\bhr\b|recruiter|talent acquisition|\bfinance\b|accounting|customer (support|success)|content writer|copywriter|graphic designer|data entry|administrative assistant|office assistant|paralegal|legal counsel)\b/i;

export function prefilterPosting(
  posting: { title: string; locationPolicy: LocationPolicy },
  market: Market,
): PrefilterResult {
  if (SENIOR_TITLE_PATTERN.test(posting.title)) {
    return { drop: true, reason: "senior/lead/principal/manager title" };
  }
  if (NON_ENGINEERING_PATTERN.test(posting.title)) {
    return { drop: true, reason: "non-engineering role" };
  }
  if (market === "remote" && posting.locationPolicy === "region_locked") {
    return { drop: true, reason: "region-locked remote role excludes Nepal" };
  }
  return { drop: false };
}
