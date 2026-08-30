import { describe, expect, it } from "vitest";
import { buildScoringPrompt } from "../../src/scoring/prompt.js";
import type { Profile } from "../../src/scoring/types.js";

const profile: Profile = {
  solid: ["React", "TypeScript"],
  working: ["Supabase/pgvector"],
  learning: ["DSA"],
  next: ["Docker"],
  constraints: {
    location: "Nepal (UTC+5:45)",
    workVisa: false,
    eligibility: "worldwide or contractor-eligible remote roles only",
    level: "entry/junior level only",
  },
};

describe("buildScoringPrompt", () => {
  it("includes every profile tier and the posting's own fields", () => {
    const prompt = buildScoringPrompt(
      {
        title: "Junior Full-Stack Developer",
        description: "Build things with React and Node.",
        market: "remote",
        location: "Anywhere",
        locationPolicy: "worldwide",
        timezoneRequirement: null,
      },
      profile,
    );

    expect(prompt).toContain("React");
    expect(prompt).toContain("Supabase/pgvector");
    expect(prompt).toContain("DSA");
    expect(prompt).toContain("Docker");
    expect(prompt).toContain("Junior Full-Stack Developer");
    expect(prompt).toContain("Build things with React and Node.");
    expect(prompt).toContain("worldwide");
    expect(prompt).toContain("none stated");
  });

  it("falls back to placeholder text for absent location/timezone fields", () => {
    const prompt = buildScoringPrompt(
      {
        title: "Junior Dev",
        description: "d",
        market: "nepal",
        location: null,
        locationPolicy: "unknown",
        timezoneRequirement: null,
      },
      profile,
    );
    expect(prompt).toContain("unspecified");
    expect(prompt).toContain("none stated");
  });
});
