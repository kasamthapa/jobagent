import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { merojobAdapter } from "../../../src/sources/adapters/merojob.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = readFileSync(fileURLToPath(new URL("../../fixtures/merojob.html", import.meta.url)), "utf-8");
const emptyFixture = readFileSync(
  fileURLToPath(new URL("../../fixtures/nepal-no-listings.html", import.meta.url)),
  "utf-8",
);

const source: Source = {
  name: "merojob",
  market: "nepal",
  kind: "portal",
  // The old /category/* page renders its list client-side (0 static job
  // links); the homepage's "latest jobs" feed server-renders real ones, so
  // that's the configured URL now (see data/sources.json's "note" on this
  // source). It's not IT-filtered — the Phase 4 prefilter/scorer handle
  // that, same as the HN "Who's Hiring" firehose in Phase 2.
  url: "https://merojob.com/",
  adapter: "merojob",
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

describe("merojobAdapter", () => {
  it("maps job cards to RawPosting, ignoring nav chrome", async () => {
    stubFetch(200, fixture);
    const postings = await merojobAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      externalId: "458213",
      title: "Junior Frontend Developer",
      companyName: "Webtech Nepal Pvt. Ltd.",
    });
    // The homepage feed's cards don't carry a per-card location string,
    // unlike the old category-page markup.
    expect(postings[0]?.location).toBeUndefined();
    expect(postings[1]?.externalId).toBe("458220");
  });

  it("throws when the heuristic finds 0 listings (e.g. a JS-rendered category page) instead of returning []", async () => {
    stubFetch(200, emptyFixture);
    await expect(merojobAdapter.fetch(source)).rejects.toThrow(/selector matched 0 job listings/);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(503, "");
    await expect(merojobAdapter.fetch(source)).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the source has no url configured", async () => {
    await expect(merojobAdapter.fetch({ ...source, url: null })).rejects.toThrow(/no url/);
  });
});
