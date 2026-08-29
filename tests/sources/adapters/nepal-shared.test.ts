import { describe, expect, it, afterEach, vi } from "vitest";
import { extractJobCards, fetchHtml, prettifyName } from "../../../src/sources/adapters/nepal-shared.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("extractJobCards", () => {
  const html = `
    <nav>
      <a href="/">Home</a>
      <a href="/about-us">About Us</a>
      <a href="/login">Login</a>
      <a href="/category/finance">Finance</a>
    </nav>
    <div class="job-item">
      <a href="/job/junior-frontend-developer-458213"><h2>Junior Frontend Developer</h2></a>
      <a href="/company/webtech-nepal">Webtech Nepal Pvt. Ltd.</a>
      <p>Kathmandu, Nepal</p>
      <a href="/job/junior-frontend-developer-458213">View Details</a>
    </div>
  `;
  const baseUrl = "https://portal.test/category/it";

  it("finds the job card, ignoring nav chrome and collapsing the title/'View Details' links into one", () => {
    const cards = extractJobCards(html, baseUrl, { requireNumericId: true });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      externalId: "458213",
      title: "Junior Frontend Developer",
      url: "https://portal.test/job/junior-frontend-developer-458213",
      companyName: "Webtech Nepal Pvt. Ltd.",
      location: "Kathmandu",
    });
  });

  it("returns [] (not a throw) when nothing matches — callers decide whether that's an error", () => {
    const chromeOnly = `<nav><a href="/">Home</a><a href="/login">Login</a></nav>`;
    expect(extractJobCards(chromeOnly, baseUrl)).toEqual([]);
  });

  it("requireNumericId filters out same-shaped links that don't carry an id, like company profile links", () => {
    const withoutRequire = extractJobCards(html, baseUrl, { requireNumericId: false });
    // Without the id requirement, the company-profile link ("Webtech Nepal
    // Pvt. Ltd.", no digits in its path) would also look like a candidate.
    expect(withoutRequire.some((c) => c.url.includes("/company/"))).toBe(true);

    const withRequire = extractJobCards(html, baseUrl, { requireNumericId: true });
    expect(withRequire.some((c) => c.url.includes("/company/"))).toBe(false);
  });

  it("falls back to a hashed id and fallbackCompanyName when the URL has no numeric id and no company link exists", () => {
    const careersHtml = `<a href="/careers/qa-analyst">QA Analyst</a>`;
    const cards = extractJobCards(careersHtml, "https://acme.test/careers", {
      fallbackCompanyName: "Acme Corp",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.externalId).toMatch(/^[0-9a-f]{16}$/);
    expect(cards[0]?.companyName).toBe("Acme Corp");
  });
});

describe("prettifyName", () => {
  it("title-cases a hyphenated registry slug", () => {
    expect(prettifyName("leapfrog-technology")).toBe("Leapfrog Technology");
    expect(prettifyName("f1soft")).toBe("F1soft");
  });
});

describe("fetchHtml", () => {
  it("throws with the URL and status on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchHtml("https://portal.test/jobs")).rejects.toThrow(/HTTP 503/);
  });

  it("throttles a second request to the same host to at least 1 req/sec", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<html></html>" });
    vi.stubGlobal("fetch", fetchMock);

    await fetchHtml("https://throttle.test/a");

    let secondResolved = false;
    const second = fetchHtml("https://throttle.test/b").then(() => {
      secondResolved = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(secondResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    await second;
    expect(secondResolved).toBe(true);
  });
});
