import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parseArgs, runInit, runPoll, runScore, runDigest } from "../src/cli.js";

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

describe("phase-2+ stub commands", () => {
  it("runPoll logs a stub message and does not throw", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => runPoll({ market: "remote" })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("runScore logs a stub message and does not throw", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => runScore()).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("runDigest logs a stub message and does not throw", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => runDigest()).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
