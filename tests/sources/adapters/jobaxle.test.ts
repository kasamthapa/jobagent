import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobaxleAdapter } from "../../../src/sources/adapters/jobaxle.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = readFileSync(fileURLToPath(new URL("../../fixtures/jobaxle.html", import.meta.url)), "utf-8");
const emptyFixture = readFileSync(
  fileURLToPath(new URL("../../fixtures/nepal-no-listings.html", import.meta.url)),
  "utf-8",
);

const source: Source = {
  name: "jobaxle",
  market: "nepal",
  kind: "portal",
  url: "https://jobaxle.com",
  adapter: "jobaxle",
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

describe("jobaxleAdapter", () => {
  it("maps job cards to RawPosting", async () => {
    stubFetch(200, fixture);
    const postings = await jobaxleAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      externalId: "22045",
      title: "React Native Developer",
      companyName: "CraftsApp Nepal",
      location: "Kathmandu",
    });
    expect(postings[1]).toMatchObject({
      externalId: "22050",
      title: "QA Engineer",
      companyName: "Nabil Tech",
      location: "Remote",
    });
  });

  it("throws when the heuristic finds 0 listings (e.g. the real homepage, which is mostly category links) instead of returning []", async () => {
    stubFetch(200, emptyFixture);
    await expect(jobaxleAdapter.fetch(source)).rejects.toThrow(/selector matched 0 job listings/);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(502, "");
    await expect(jobaxleAdapter.fetch(source)).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the source has no url configured", async () => {
    await expect(jobaxleAdapter.fetch({ ...source, url: null })).rejects.toThrow(/no url/);
  });
});
