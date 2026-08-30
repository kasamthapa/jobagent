import type { Market } from "../sources/types.js";
import type { Profile } from "./types.js";

/** The subset of a posting's fields the scoring prompt needs. */
export interface PromptPosting {
  title: string;
  description: string;
  market: Market;
  location: string | null;
  locationPolicy: string;
  timezoneRequirement: string | null;
}

/**
 * Builds the strict-JSON scoring prompt sent to Gemini. Kept as its own
 * pure function so the prompt content is testable without a network call.
 */
export function buildScoringPrompt(posting: PromptPosting, profile: Profile): string {
  return `You are scoring a job posting against a fixed candidate profile for an entry/junior full-stack developer job search.

Candidate profile:
- Solid (confidently uses in production): ${profile.solid.join(", ")}
- Working knowledge (used, still building depth): ${profile.working.join(", ")}
- Learning (actively studying, not yet applied at work): ${profile.learning.join(", ")}
- Next (planned, not started): ${profile.next.join(", ")}
- Constraints: based in ${profile.constraints.location}, work visa: ${
    profile.constraints.workVisa ? "yes" : "no"
  }, ${profile.constraints.eligibility}, ${profile.constraints.level}.

Job posting (market: ${posting.market}):
Title: ${posting.title}
Location: ${posting.location ?? "unspecified"} (policy: ${posting.locationPolicy})
Timezone requirement: ${posting.timezoneRequirement ?? "none stated"}
Description:
${posting.description}

Score this posting for the candidate above. Respond with strict JSON only, no
markdown fences, matching exactly this shape:
{"score": <integer 0-100>, "tier": "safe" | "stretch" | "reach" | "no", "reasoning": "<one or two sentences>", "gaps": ["<skill>", ...]}

Tier definitions:
- "safe": the role needs only skills from the Solid list.
- "stretch": the role leans on Working and Learning skills — this is the target zone; favor it when the fit is genuine.
- "reach": the role needs 2 or more skills the candidate does not have at all.
- "no": wrong seniority level, wrong discipline, or the candidate is ineligible (e.g. visa/location).

Return ONLY the JSON object, nothing else.`;
}
