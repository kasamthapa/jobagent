import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "../../src/db/schema.js";
import { upsertSource, listSources, getSourceByName, countTables } from "../../src/db/queries.js";
import type { Source } from "../../src/sources/types.js";

const remotive: Source = {
  name: "remotive",
  market: "remote",
  kind: "api",
  url: "https://remotive.com/api/remote-jobs",
  adapter: "remotive",
  active: true,
};

describe("upsertSource / listSources / getSourceByName", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("inserts a new source", () => {
    upsertSource(db, remotive);
    const rows = listSources(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "remotive",
      market: "remote",
      kind: "api",
      url: remotive.url,
      adapter: "remotive",
      active: 1,
    });
  });

  it("updates config columns instead of duplicating on a repeat name", () => {
    upsertSource(db, remotive);
    upsertSource(db, { ...remotive, url: "https://remotive.com/api/v2", active: false });
    const rows = listSources(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe("https://remotive.com/api/v2");
    expect(rows[0]?.active).toBe(0);
  });

  it("looks up a source by name", () => {
    upsertSource(db, remotive);
    expect(getSourceByName(db, "remotive")?.name).toBe("remotive");
    expect(getSourceByName(db, "nope")).toBeUndefined();
  });
});

describe("countTables", () => {
  it("counts rows in every table, starting at zero", () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(countTables(db)).toEqual({ sources: 0, companies: 0, postings: 0, matches: 0 });
    upsertSource(db, remotive);
    expect(countTables(db).sources).toBe(1);
    db.close();
  });
});
