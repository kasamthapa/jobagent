import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arbeitnowAdapter } from "../../../src/sources/adapters/arbeitnow.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/arbeitnow.json", import.meta.url)), "utf-8"),
);

const source: Source = {
  name: "arbeitnow",
  market: "remote",
  kind: "api",
  url: "https://www.arbeitnow.com/api/job-board-api",
  adapter: "arbeitnow",
  active: true,
};

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("arbeitnowAdapter", () => {
  it("marks a remote job with no location text as worldwide", async () => {
    stubFetch(200, fixture);
    const postings = await arbeitnowAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      externalId: "junior-fullstack-developer-berlin-startup",
      title: "Junior Fullstack Developer",
      locationPolicy: "worldwide",
    });
  });

  it("marks a non-remote job as region_locked regardless of location text", async () => {
    stubFetch(200, fixture);
    const postings = await arbeitnowAdapter.fetch(source);
    expect(postings[1]).toMatchObject({
      title: "Office Administrator",
      location: "Munich, Germany",
      locationPolicy: "region_locked",
    });
  });

  it("throws when the response doesn't match the expected shape", async () => {
    stubFetch(200, { nope: [] });
    await expect(arbeitnowAdapter.fetch(source)).rejects.toThrow();
  });
});
