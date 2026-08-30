import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parseArgs, runInit, runPoll, runScore, runDigest } from "../src/cli.js";
import type { Source } from "../src/sources/types.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobagent-cli-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseArgs", () => {
  it("parses a bare command", () => {
    expect(parseArgs(["init"])).toEqual({ command: "init", flags: {} });
  });

  it("parses --flag value pairs", () => {
    expect(parseArgs(["poll", "--market", "remote"])).toEqual({
      command: "poll",
      flags: { market: "remote" },
    });
  });

  it("treats a flag with no following value as boolean-true", () => {
    expect(parseArgs(["poll", "--market"])).toEqual({
      command: "poll",
      flags: { market: "true" },
    });
  });

  it("throws on an unknown command", () => {
    expect(() => parseArgs(["bogus"])).toThrow(/Unknown command/);
  });

  it("throws when no command is given", () => {
    expect(() => parseArgs([])).toThrow(/Unknown command/);
  });
});

describe("runInit", () => {
  it("creates the db with all four tables and loads the registry", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "jobs.db");
    const registryPath = join(dir, "sources.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { name: "a", market: "remote", kind: "api", url: "https://x.test", adapter: "a", active: true },
        { name: "b", market: "nepal", kind: "portal", url: "https://y.test", adapter: "b", active: true },
      ]),
    );

    runInit(dbPath, registryPath);

    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(["companies", "matches", "postings", "sources"]);
    const sourceCount = (db.prepare(`SELECT COUNT(*) AS n FROM sources`).get() as { n: number }).n;
    expect(sourceCount).toBe(2);
    db.close();
  });

  it("is idempotent — running it twice does not duplicate sources", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "jobs.db");
    const registryPath = join(dir, "sources.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { name: "a", market: "remote", kind: "api", url: "https://x.test", adapter: "a", active: true },
      ]),
    );

    runInit(dbPath, registryPath);
    runInit(dbPath, registryPath);

    const db = new Database(dbPath, { readonly: true });
    const sourceCount = (db.prepare(`SELECT COUNT(*) AS n FROM sources`).get() as { n: number }).n;
    expect(sourceCount).toBe(1);
    db.close();
  });
});

describe("runPoll", () => {
  function writeRegistry(sources: Source[]): { dir: string; dbPath: string; registryPath: string } {
    const dir = tmpDir();
    const dbPath = join(dir, "jobs.db");
    const registryPath = join(dir, "sources.json");
    writeFileSync(registryPath, JSON.stringify(sources));
    return { dir, dbPath, registryPath };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unknown --market value without touching the db", async () => {
    const { dbPath, registryPath } = writeRegistry([]);
    runInit(dbPath, registryPath);
    await expect(runPoll({ market: "atlantis" }, dbPath)).rejects.toThrow(/Unknown market/);
  });

  it("skips sources whose adapter isn't implemented yet, without hitting the network", async () => {
    const { dbPath, registryPath } = writeRegistry([
      {
        name: "future-portal",
        market: "nepal",
        kind: "portal",
        url: "https://future-portal.test",
        adapter: "future-portal",
        active: true,
      },
    ]);
    runInit(dbPath, registryPath);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPoll({}, dbPath);
    logSpy.mockRestore();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters by --market and only polls active sources in that market", async () => {
    const { dbPath, registryPath } = writeRegistry([
      { name: "remotive", market: "remote", kind: "api", url: "https://remotive.test", adapter: "remotive", active: true },
      { name: "merojob", market: "nepal", kind: "portal", url: "https://merojob.test", adapter: "merojob", active: true },
    ]);
    runInit(dbPath, registryPath);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ jobs: [] }) }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPoll({ market: "remote" }, dbPath);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    logSpy.mockRestore();

    expect(logged).toContain("remotive: 0 postings");
    expect(logged).not.toContain("merojob");
  });

  it("upserts postings from a successful fetch and records source health", async () => {
    const { dbPath, registryPath } = writeRegistry([
      { name: "remotive", market: "remote", kind: "api", url: "https://remotive.test", adapter: "remotive", active: true },
    ]);
    runInit(dbPath, registryPath);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [
            {
              id: 1,
              url: "https://remotive.test/1",
              title: "Junior Dev",
              company_name: "Acme",
              description: "<p>Build things.</p>",
            },
          ],
        }),
      }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPoll({}, dbPath);
    logSpy.mockRestore();

    const db = new Database(dbPath, { readonly: true });
    const postingCount = (db.prepare(`SELECT COUNT(*) AS n FROM postings`).get() as { n: number }).n;
    const source = db.prepare(`SELECT * FROM sources WHERE name = 'remotive'`).get() as Record<string, unknown>;
    db.close();

    expect(postingCount).toBe(1);
    expect(source.last_result_count).toBe(1);
    expect(source.last_error).toBeNull();
  });

  it("records a fetch failure to sources.last_error and continues rather than throwing", async () => {
    const { dbPath, registryPath } = writeRegistry([
      { name: "remotive", market: "remote", kind: "api", url: "https://remotive.test", adapter: "remotive", active: true },
    ]);
    runInit(dbPath, registryPath);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runPoll({}, dbPath)).resolves.toBeUndefined();
    logSpy.mockRestore();

    const db = new Database(dbPath, { readonly: true });
    const source = db.prepare(`SELECT * FROM sources WHERE name = 'remotive'`).get() as Record<string, unknown>;
    db.close();

    expect(source.last_error).toMatch(/HTTP 503/);
    expect(source.last_result_count).toBeNull();
  });
});

describe("runScore", () => {
  function setUp(): { dbPath: string; profilePath: string } {
    const dir = tmpDir();
    const dbPath = join(dir, "jobs.db");
    const registryPath = join(dir, "sources.json");
    const profilePath = join(dir, "profile.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { name: "remotive", market: "remote", kind: "api", url: "https://x.test", adapter: "remotive", active: true },
      ]),
    );
    writeFileSync(
      profilePath,
      JSON.stringify({
        solid: ["React"],
        working: ["Vitest"],
        learning: ["DSA"],
        next: ["Docker"],
        constraints: {
          location: "Nepal (UTC+5:45)",
          workVisa: false,
          eligibility: "worldwide or contractor-eligible remote roles only",
          level: "entry/junior level only",
        },
      }),
    );
    runInit(dbPath, registryPath);
    return { dbPath, profilePath };
  }

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    vi.unstubAllGlobals();
  });

  it("without GEMINI_API_KEY, prefilters and records the rest as unscored, without throwing", async () => {
    delete process.env.GEMINI_API_KEY;
    const { dbPath, profilePath } = setUp();
    const db = new Database(dbPath);
    const sourceId = (db.prepare(`SELECT id FROM sources WHERE name = 'remotive'`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO postings (source_id, external_id, title, description, url, location_policy, first_seen_at, last_seen_at, content_hash, dedupe_key)
       VALUES (?, 'e1', 'Junior Full-Stack Developer', 'Build things.', 'https://x.test/1', 'worldwide', '2026-01-01', '2026-01-01', 'h1', 'd1')`,
    ).run(sourceId);
    db.close();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runScore(dbPath, profilePath)).resolves.toBeUndefined();
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    logSpy.mockRestore();

    expect(logged).toContain("GEMINI_API_KEY not set");
    expect(logged).toMatch(/Tier distribution/);
    expect(logged).toMatch(/Cache hit rate/);

    const match = new Database(dbPath, { readonly: true })
      .prepare(`SELECT * FROM matches`)
      .get() as Record<string, unknown>;
    expect(match.tier).toBeNull();
    expect(match.reasoning).toMatch(/no GEMINI_API_KEY/);
  });

  it("drops a senior title via the prefilter and populates matches without calling Gemini", async () => {
    const { dbPath, profilePath } = setUp();
    const db = new Database(dbPath);
    const sourceId = (db.prepare(`SELECT id FROM sources WHERE name = 'remotive'`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO postings (source_id, external_id, title, description, url, location_policy, first_seen_at, last_seen_at, content_hash, dedupe_key)
       VALUES (?, 'e1', 'Senior Full-Stack Developer', 'Build things.', 'https://x.test/1', 'worldwide', '2026-01-01', '2026-01-01', 'h1', 'd1')`,
    ).run(sourceId);
    db.close();

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.GEMINI_API_KEY = "test-key";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScore(dbPath, profilePath);
    logSpy.mockRestore();

    expect(fetchSpy).not.toHaveBeenCalled();
    const match = new Database(dbPath, { readonly: true })
      .prepare(`SELECT * FROM matches`)
      .get() as Record<string, unknown>;
    expect(match.tier).toBe("no");
  });
});

describe("phase-2+ stub commands", () => {
  it("runDigest logs a stub message and does not throw", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => runDigest()).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
