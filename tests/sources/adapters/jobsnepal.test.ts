import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobsnepalAdapter } from "../../../src/sources/adapters/jobsnepal.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = readFileSync(fileURLToPath(new URL("../../fixtures/jobsnepal.html", import.meta.url)), "utf-8");
const emptyFixture = readFileSync(
  fileURLToPath(new URL("../../fixtures/nepal-no-listings.html", import.meta.url)),
  "utf-8",
);

const source: Source = {
  name: "jobsnepal",
  market: "nepal",
  kind: "portal",
  url: "https://www.jobsnepal.com/category/information-technology-jobs",
  adapter: "jobsnepal",
  active: true,
};

function stubFetch(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => body }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jobsnepalAdapter", () => {
  it("maps job cards to RawPosting, leaving companyName unset when it's plain text rather than a link", async () => {
    stubFetch(200, fixture);
    const postings = await jobsnepalAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({ externalId: "143673", title: "Information Technology Officer", location: "Kathmandu" });
    expect(postings[0]?.companyName).toBeUndefined();
    expect(postings[1]).toMatchObject({
      externalId: "143680",
      title: "Junior Software Engineer",
      companyName: "e-Education",
      location: "Lalitpur",
    });
  });

  it("throws when the heuristic finds 0 listings instead of returning []", async () => {
    stubFetch(200, emptyFixture);
    await expect(jobsnepalAdapter.fetch(source)).rejects.toThrow(/selector matched 0 job listings/);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(404, "");
    await expect(jobsnepalAdapter.fetch(source)).rejects.toThrow(/HTTP 404/);
  });

  it("throws when the source has no url configured", async () => {
    await expect(jobsnepalAdapter.fetch({ ...source, url: null })).rejects.toThrow(/no url/);
  });
});
