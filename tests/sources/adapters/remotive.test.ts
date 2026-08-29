import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remotiveAdapter } from "../../../src/sources/adapters/remotive.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/remotive.json", import.meta.url)), "utf-8"),
);

const source: Source = {
  name: "remotive",
  market: "remote",
  kind: "api",
  url: "https://remotive.com/api/remote-jobs?category=software-dev",
  adapter: "remotive",
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

describe("remotiveAdapter", () => {
  it("maps Remotive jobs to RawPosting, strips HTML, and infers location_policy", async () => {
    stubFetch(200, fixture);
    const postings = await remotiveAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      externalId: "111",
      title: "Junior React Developer",
      companyName: "Acme Remote",
      locationPolicy: "worldwide",
    });
    expect(postings[0]?.description).toBe("Build React apps with our small team.");
    expect(postings[1]?.locationPolicy).toBe("region_locked");
    expect(postings[1]?.salaryText).toBe("$120,000 - $150,000");
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(500, {});
    await expect(remotiveAdapter.fetch(source)).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the response doesn't match the expected shape", async () => {
    stubFetch(200, { jobs: [{ title: "missing everything else" }] });
    await expect(remotiveAdapter.fetch(source)).rejects.toThrow();
  });

  it("throws when the source has no url configured", async () => {
    await expect(remotiveAdapter.fetch({ ...source, url: null })).rejects.toThrow(/no url/);
  });
});
