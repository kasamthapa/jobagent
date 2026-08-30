import { describe, expect, it } from "vitest";
import { prefilterPosting } from "../../src/scoring/prefilter.js";

describe("prefilterPosting", () => {
  it("drops senior/lead/principal/manager titles", () => {
    for (const title of [
      "Senior Full-Stack Developer",
      "Lead Backend Engineer",
      "Principal Software Engineer",
      "Engineering Manager",
      "Director of Engineering",
    ]) {
      const result = prefilterPosting({ title, locationPolicy: "worldwide" }, "remote");
      expect(result.drop, title).toBe(true);
      expect(result.reason).toMatch(/senior\/lead\/principal\/manager/);
    }
  });

  it("drops non-engineering roles", () => {
    const result = prefilterPosting(
      { title: "Sales Account Executive", locationPolicy: "worldwide" },
      "remote",
    );
    expect(result.drop).toBe(true);
    expect(result.reason).toMatch(/non-engineering/);
  });

  it("drops region-locked remote roles", () => {
    const result = prefilterPosting(
      { title: "Junior Full-Stack Developer", locationPolicy: "region_locked" },
      "remote",
    );
    expect(result.drop).toBe(true);
    expect(result.reason).toMatch(/region-locked/);
  });

  it("does not drop a Nepal posting for being region_locked", () => {
    const result = prefilterPosting(
      { title: "Junior Full-Stack Developer", locationPolicy: "region_locked" },
      "nepal",
    );
    expect(result.drop).toBe(false);
  });

  it("keeps an entry-level engineering role in a worldwide remote posting", () => {
    const result = prefilterPosting(
      { title: "Junior Full-Stack Developer", locationPolicy: "worldwide" },
      "remote",
    );
    expect(result).toEqual({ drop: false });
  });
});
