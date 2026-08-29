import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kumarijobAdapter } from "../../../src/sources/adapters/kumarijob.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = readFileSync(fileURLToPath(new URL("../../fixtures/kumarijob.html", import.meta.url)), "utf-8");
const emptyFixture = readFileSync(
  fileURLToPath(new URL("../../fixtures/nepal-no-listings.html", import.meta.url)),
  "utf-8",
);

const source: Source = {
  name: "kumarijob",
  market: "nepal",
  kind: "portal",
  url: "https://www.kumarijob.com/job-listing/it-jobs-in-nepal",
  adapter: "kumarijob",
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

describe("kumarijobAdapter", () => {
  it("maps job cards to RawPosting, collapsing the title link and 'View Detail' link into one card each", async () => {
    stubFetch(200, fixture);
    const postings = await kumarijobAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      externalId: "75604",
      title: "Jr. Associate-Retail Support",
      companyName: "Classic Tech Pvt. Ltd.",
      location: "Kathmandu",
    });
    expect(postings[1]).toMatchObject({
      externalId: "75279",
      title: "Senior Full Stack Developer (Backend)",
      companyName: "Code Mantra",
      location: "Lalitpur",
    });
  });

  it("throws when the heuristic finds 0 listings instead of returning []", async () => {
    stubFetch(200, emptyFixture);
    await expect(kumarijobAdapter.fetch(source)).rejects.toThrow(/selector matched 0 job listings/);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(500, "");
    await expect(kumarijobAdapter.fetch(source)).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the source has no url configured", async () => {
    await expect(kumarijobAdapter.fetch({ ...source, url: null })).rejects.toThrow(/no url/);
  });
});
