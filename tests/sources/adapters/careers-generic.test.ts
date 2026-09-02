import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { careersGenericAdapter } from "../../../src/sources/adapters/careers-generic.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = readFileSync(
  fileURLToPath(new URL("../../fixtures/careers-generic.html", import.meta.url)),
  "utf-8",
);
const emptyFixture = readFileSync(
  fileURLToPath(new URL("../../fixtures/nepal-no-listings.html", import.meta.url)),
  "utf-8",
);

const source: Source = {
  name: "example-tech",
  market: "nepal",
  kind: "careers",
  url: "https://example-tech.test/careers",
  adapter: "careers-generic",
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

describe("careersGenericAdapter", () => {
  it("maps job cards to RawPosting, falling back to the registry name (prettified) for companyName", async () => {
    stubFetch(200, fixture);
    const postings = await careersGenericAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    // Title text includes the site's own "Apply Now" suffix baked into the
    // link text (real pattern seen on softnep.com/opportunities/jobs) —
    // the heuristic doesn't strip it, it just extracts whatever the link says.
    expect(postings[0]).toMatchObject({ title: "Junior Full Stack Developer Apply Now", companyName: "Example Tech" });
    expect(postings[1]).toMatchObject({ title: "QA Analyst Apply Now", companyName: "Example Tech" });
    // Careers-page job links rarely carry a numeric id, so externalId falls back to a hash of the URL.
    expect(postings[0]?.externalId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("throws when the heuristic finds 0 listings (e.g. a 'contact us to apply' page with no per-role links) instead of returning []", async () => {
    stubFetch(200, emptyFixture);
    await expect(careersGenericAdapter.fetch(source)).rejects.toThrow(/selector matched 0 job listings/);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(403, "");
    await expect(careersGenericAdapter.fetch(source)).rejects.toThrow(/HTTP 403/);
  });

  it("throws when the source has no url configured", async () => {
    await expect(careersGenericAdapter.fetch({ ...source, url: null })).rejects.toThrow(/no url/);
  });
});
