import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/schema.js";
import { upsertSource } from "../src/db/queries.js";
import { runDoctorChecks, renderDoctorReport } from "../src/doctor.js";
import type { Source } from "../src/sources/types.js";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    name: "remotive",
    market: "remote",
    kind: "api",
    url: "https://remotive.test/api",
    adapter: "remotive",
    active: true,
    ...overrides,
  };
}

describe("runDoctorChecks", () => {
  it("reports db integrity ok on a freshly created database", async () => {
    const db = openDb(":memory:");
    const report = await runDoctorChecks(db, { hasGeminiKey: true, sources: [] });
    db.close();

    const dbCheck = report.checks.find((c) => c.name === "db integrity");
    expect(dbCheck?.ok).toBe(true);
  });

  it("reports the GEMINI_API_KEY check based on hasGeminiKey", async () => {
    const db = openDb(":memory:");
    const withKey = await runDoctorChecks(db, { hasGeminiKey: true, sources: [] });
    const withoutKey = await runDoctorChecks(db, { hasGeminiKey: false, sources: [] });
    db.close();

    expect(withKey.checks.find((c) => c.name === "GEMINI_API_KEY")?.ok).toBe(true);
    expect(withoutKey.checks.find((c) => c.name === "GEMINI_API_KEY")?.ok).toBe(false);
  });

  it("marks a source reachable on a 2xx (or non-5xx) response", async () => {
    const db = openDb(":memory:");
    upsertSource(db, makeSource());
    const sources = db.prepare(`SELECT * FROM sources`).all() as Array<Parameters<typeof runDoctorChecks>[1]["sources"][number]>;
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });

    const report = await runDoctorChecks(db, { hasGeminiKey: true, sources, fetchImpl });
    db.close();

    const sourceCheck = report.checks.find((c) => c.name === "source:remotive");
    expect(sourceCheck?.ok).toBe(true);
    expect(sourceCheck?.detail).toBe("HTTP 200");
  });

  it("marks a source unreachable on a 5xx response", async () => {
    const db = openDb(":memory:");
    upsertSource(db, makeSource());
    const sources = db.prepare(`SELECT * FROM sources`).all() as Array<Parameters<typeof runDoctorChecks>[1]["sources"][number]>;
    const fetchImpl = vi.fn().mockResolvedValue({ status: 500 });

    const report = await runDoctorChecks(db, { hasGeminiKey: true, sources, fetchImpl });
    db.close();

    expect(report.checks.find((c) => c.name === "source:remotive")?.ok).toBe(false);
  });

  it("marks a source unreachable when fetch throws, without crashing the run", async () => {
    const db = openDb(":memory:");
    upsertSource(db, makeSource());
    const sources = db.prepare(`SELECT * FROM sources`).all() as Array<Parameters<typeof runDoctorChecks>[1]["sources"][number]>;
    const fetchImpl = vi.fn().mockRejectedValue(new Error("DNS lookup failed"));

    const report = await runDoctorChecks(db, { hasGeminiKey: true, sources, fetchImpl });
    db.close();

    const check = report.checks.find((c) => c.name === "source:remotive");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/DNS lookup failed/);
  });

  it("skips a null-url source (unverifiable careers page) as ok", async () => {
    const db = openDb(":memory:");
    upsertSource(db, makeSource({ name: "some-co", url: null, kind: "careers", adapter: "careers-generic" }));
    const sources = db.prepare(`SELECT * FROM sources`).all() as Array<Parameters<typeof runDoctorChecks>[1]["sources"][number]>;
    const fetchImpl = vi.fn();

    const report = await runDoctorChecks(db, { hasGeminiKey: true, sources, fetchImpl });
    db.close();

    expect(report.checks.find((c) => c.name === "source:some-co")?.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips inactive sources entirely", async () => {
    const db = openDb(":memory:");
    upsertSource(db, makeSource({ active: false }));
    const sources = db.prepare(`SELECT * FROM sources`).all() as Array<Parameters<typeof runDoctorChecks>[1]["sources"][number]>;
    const fetchImpl = vi.fn();

    const report = await runDoctorChecks(db, { hasGeminiKey: true, sources, fetchImpl });
    db.close();

    expect(report.checks.some((c) => c.name === "source:remotive")).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("renderDoctorReport", () => {
  it("renders each check and a pass/fail tally", () => {
    const md = renderDoctorReport({
      checks: [
        { name: "db integrity", ok: true, detail: "ok" },
        { name: "GEMINI_API_KEY", ok: false, detail: "not set" },
      ],
    });
    expect(md).toContain("[OK] db integrity — ok");
    expect(md).toContain("[FAIL] GEMINI_API_KEY — not set");
    expect(md).toContain("1/2 checks passed.");
  });
});
