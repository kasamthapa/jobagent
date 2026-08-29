import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hnAlgoliaAdapter } from "../../../src/sources/adapters/hn-algolia.js";
import type { Source } from "../../../src/sources/types.js";

const searchFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/hn-search.json", import.meta.url)), "utf-8"),
);
const itemFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/hn-item.json", import.meta.url)), "utf-8"),
);

const source: Source = {
  name: "hn-whoishiring",
  market: "remote",
  kind: "api",
  url: "https://hn.algolia.com/api/v1/",
  adapter: "hn-algolia",
  active: true,
};

function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation((url: string) => {
    const body = url.includes("search_by_date") ? searchFixture : itemFixture;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hnAlgoliaAdapter", () => {
  it("finds the latest thread, then maps its top-level comments only", async () => {
    const fetchMock = stubFetch();
    const postings = await hnAlgoliaAdapter.fetch(source);

    // one search call, one item call — nested replies must not trigger extra fetches
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postings).toHaveLength(2); // only the null-text comment (49156701) is excluded
    expect(postings[0]).toMatchObject({
      externalId: "49156700",
      url: "https://news.ycombinator.com/item?id=49156700",
      title: "Acme Corp | Remote (Worldwide) | Full-Stack Developer (Junior)",
    });
    expect(postings[0]?.description).toContain("junior full-stack developer");
  });

  it("skips deleted comments (no text/author) and never descends into nested replies", async () => {
    stubFetch();
    const postings = await hnAlgoliaAdapter.fetch(source);
    // 49156701 has null text/author (deleted); 49156703 is a reply nested under
    // 49156702, not a top-level comment on the story, so it's never visited.
    expect(postings.map((p) => p.externalId)).not.toContain("49156701");
    expect(postings.map((p) => p.externalId)).not.toContain("49156703");
    // 49156702 is itself a top-level comment with real text/author, so it
    // does surface as a (low-quality) candidate posting — Phase 4 filters these.
    expect(postings.map((p) => p.externalId)).toContain("49156702");
  });

  it("throws when no 'who is hiring' thread is found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hits: [] }) }),
    );
    await expect(hnAlgoliaAdapter.fetch(source)).rejects.toThrow(/no 'who is hiring'/i);
  });
});
