import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { himalayasAdapter } from "../../../src/sources/adapters/himalayas.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/himalayas.json", import.meta.url)), "utf-8"),
);

const source: Source = {
  name: "himalayas",
  market: "remote",
  kind: "api",
  url: "https://himalayas.app/jobs/api",
  adapter: "himalayas",
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

describe("himalayasAdapter", () => {
  it("treats no locationRestrictions as worldwide", async () => {
    stubFetch(200, fixture);
    const postings = await himalayasAdapter.fetch(source);

    expect(postings).toHaveLength(3);
    expect(postings[0]).toMatchObject({
      externalId: "https://himalayas.app/companies/acme/jobs/junior-fullstack-engineer",
      title: "Junior Fullstack Engineer",
      locationPolicy: "worldwide",
      salaryText: "USD 30000-45000",
    });
    expect(postings[0]?.timezoneRequirement).toBeUndefined();
  });

  it("treats a named country restriction as region_locked and formats timezoneRestrictions", async () => {
    stubFetch(200, fixture);
    const postings = await himalayasAdapter.fetch(source);
    expect(postings[1]).toMatchObject({
      locationPolicy: "region_locked",
      location: "United States",
      timezoneRequirement: "UTC-8, UTC-5",
    });
  });

  it("treats explicit null salary/currency fields (as the live API sends) as absent", async () => {
    stubFetch(200, fixture);
    const postings = await himalayasAdapter.fetch(source);
    expect(postings[2]).toMatchObject({ title: "Support Engineer" });
    expect(postings[2]?.salaryText).toBeUndefined();
  });

  it("throws when the response doesn't match the expected shape", async () => {
    stubFetch(200, { nope: [] });
    await expect(himalayasAdapter.fetch(source)).rejects.toThrow();
  });
});
