import { describe, expect, it, afterEach, vi } from "vitest";
import { fetchJson, fetchText, htmlToText, inferLocationPolicy, makeRawPosting } from "../../../src/sources/adapters/shared.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("returns the parsed body on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hello: "world" }) }),
    );
    await expect(fetchJson("https://api.test/jobs")).resolves.toEqual({ hello: "world" });
  });

  it("throws with the URL and status on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchJson("https://api.test/jobs", { delayImpl: async () => {} })).rejects.toThrow(
      /https:\/\/api\.test\/jobs responded with HTTP 500/,
    );
  });

  it("retries once on a 503 before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJson("https://api.test/jobs", { delayImpl: async () => {} })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchText", () => {
  it("returns the raw body text on a 2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<rss></rss>" }));
    await expect(fetchText("https://feed.test/jobs.rss")).resolves.toBe("<rss></rss>");
  });

  it("throws with the URL and status on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchText("https://feed.test/jobs.rss")).rejects.toThrow(/HTTP 404/);
  });
});

describe("htmlToText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(htmlToText("<p>Build   things.</p>\n<p>With <b>us</b>.</p>")).toBe("Build things. With us.");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("inferLocationPolicy", () => {
  it("defaults to worldwide when no location text is given", () => {
    expect(inferLocationPolicy(undefined)).toBe("worldwide");
    expect(inferLocationPolicy(null)).toBe("worldwide");
    expect(inferLocationPolicy("  ")).toBe("worldwide");
  });

  it("treats an explicit worldwide/global hint as worldwide", () => {
    expect(inferLocationPolicy("Remote - Global")).toBe("worldwide");
    expect(inferLocationPolicy("Work from Anywhere")).toBe("worldwide");
  });

  it("treats a named region as region_locked, even among several regions", () => {
    expect(inferLocationPolicy("Europe, USA, Canada")).toBe("region_locked");
    expect(inferLocationPolicy("US Only")).toBe("region_locked");
  });
});

describe("makeRawPosting", () => {
  const required = {
    externalId: "1",
    title: "Junior Dev",
    description: "Build things.",
    url: "https://x.test/1",
  };

  it("includes only the optional fields that are defined", () => {
    const posting = makeRawPosting(required, {
      companyName: "Acme",
      location: undefined,
      salaryText: undefined,
    });
    expect(posting).toEqual({ ...required, companyName: "Acme" });
    expect("location" in posting).toBe(false);
    expect("salaryText" in posting).toBe(false);
  });

  it("with every optional field undefined, returns exactly the required fields", () => {
    const posting = makeRawPosting(required, {});
    expect(posting).toEqual(required);
  });
});
