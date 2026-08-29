import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remoteokAdapter } from "../../../src/sources/adapters/remoteok.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/remoteok.json", import.meta.url)), "utf-8"),
);

const source: Source = {
  name: "remoteok",
  market: "remote",
  kind: "api",
  url: "https://remoteok.com/api",
  adapter: "remoteok",
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

describe("remoteokAdapter", () => {
  it("drops the leading legal-notice entry and maps the rest", async () => {
    stubFetch(200, fixture);
    const postings = await remoteokAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      externalId: "998877",
      title: "Junior Node Developer",
      companyName: "RemoteCo",
      locationPolicy: "worldwide",
      salaryText: "$40000 - $60000",
    });
    expect(postings[0]?.description).toBe("Build APIs with Node.js and Express.");
  });

  it("infers region_locked from a location naming a specific country", async () => {
    stubFetch(200, fixture);
    const postings = await remoteokAdapter.fetch(source);
    expect(postings[1]).toMatchObject({ title: "Senior Platform Engineer", locationPolicy: "region_locked" });
    expect(postings[1]?.salaryText).toBeUndefined();
  });

  it("throws when a job entry is missing required fields", async () => {
    stubFetch(200, [{ legal: "notice" }, { id: "1", position: "Dev" }]);
    await expect(remoteokAdapter.fetch(source)).rejects.toThrow();
  });
});
