import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../../src/scoring/profile.js";

describe("loadProfile", () => {
  it("loads and validates the real data/profile.json", () => {
    const profile = loadProfile();
    expect(profile.solid).toContain("React");
    expect(profile.working).toContain("Gemini API");
    expect(profile.constraints.workVisa).toBe(false);
  });

  it("throws a descriptive error on a malformed profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-profile-"));
    const path = join(dir, "profile.json");
    writeFileSync(path, JSON.stringify({ solid: "not-an-array" }));
    expect(() => loadProfile(path)).toThrow();
  });
});
