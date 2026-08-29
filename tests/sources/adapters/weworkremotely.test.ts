import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { weworkremotelyAdapter } from "../../../src/sources/adapters/weworkremotely.js";
import type { Source } from "../../../src/sources/types.js";

const fixture = readFileSync(
  fileURLToPath(new URL("../../fixtures/weworkremotely.rss.xml", import.meta.url)),
  "utf-8",
);

const source: Source = {
  name: "weworkremotely-rss",
  market: "remote",
  kind: "rss",
  url: "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  adapter: "weworkremotely-rss",
  active: true,
};

function stubFetch(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("weworkremotelyAdapter", () => {
  it("splits 'Company: Title' and strips HTML from the CDATA description", async () => {
    stubFetch(200, fixture);
    const postings = await weworkremotelyAdapter.fetch(source);

    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      externalId: "https://weworkremotely.com/remote-jobs/acme-corp-junior-full-stack-developer",
      title: "Junior Full-Stack Developer",
      companyName: "Acme Corp",
      locationPolicy: "worldwide",
    });
    expect(postings[0]?.description).toBe("Join our small remote team building web apps.");
  });

  it("infers region_locked from a region naming a specific country", async () => {
    stubFetch(200, fixture);
    const postings = await weworkremotelyAdapter.fetch(source);
    expect(postings[1]).toMatchObject({ companyName: "Beta Inc", locationPolicy: "region_locked" });
  });

  it("throws when the response isn't RSS at all", async () => {
    stubFetch(200, "<html><body>not rss</body></html>");
    await expect(weworkremotelyAdapter.fetch(source)).rejects.toThrow(/channel/);
  });
});
