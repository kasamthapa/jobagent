import type { Tier } from "../sources/types.js";

/** The owner's fixed skill profile, loaded from data/profile.json. See CLAUDE.md. */
export interface Profile {
  solid: string[];
  working: string[];
  learning: string[];
  next: string[];
  constraints: {
    location: string;
    workVisa: boolean;
    eligibility: string;
    level: string;
  };
}

/** Strict JSON shape the LLM must return for one posting. */
export interface LlmScoreResult {
  score: number;
  tier: Tier;
  reasoning: string;
  gaps: string[];
}

/** Outcome of the cheap, LLM-free pass over a posting's title/location_policy. */
export interface PrefilterResult {
  drop: boolean;
  reason?: string;
}
