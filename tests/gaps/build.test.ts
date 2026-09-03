import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/db/schema.js";
import { buildGapsData, GAP_LOOKBACK_DAYS, HIGH_NO_SCORE_THRESHOLD } from "../../src/gaps/build.js";

function seedSource(db: Database.Database, name: string, market: "nepal" | "remote"): number {
  const info = db
    .prepare(`INSERT INTO sources (name, market, kind, url, adapter, active) VALUES (?, ?, 'api', 'https://x.test', 'a', 1)`)
    .run(name, market);
  return info.lastInsertRowid as number;
}

interface Seed {
  sourceId: number;
  externalId: string;
  tier: "safe" | "stretch" | "reach" | "no";
  score?: number | null;
  gaps?: string[];
  firstSeenAt?: string;
}

function seedMatch(db: Database.Database, p: Seed): void {
  const firstSeenAt = p.firstSeenAt ?? "2026-08-15T00:00:00.000Z";
  db.prepare(
    `INSERT INTO postings (source_id, external_id, title, description, url, location_policy, first_seen_at, last_seen_at, is_open, content_hash, dedupe_key)
     VALUES (?, ?, 'T', 'D', 'u', 'worldwide', ?, ?, 1, ?, ?)`,
  ).run(p.sourceId, p.externalId, firstSeenAt, firstSeenAt, `h-${p.externalId}`, `dk-${p.externalId}`);
  const postingId = (
    db.prepare(`SELECT id FROM postings WHERE external_id = ?`).get(p.externalId) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO matches (posting_id, content_hash, score, tier, reasoning, gaps_json, scored_at)
     VALUES (?, ?, ?, ?, 'r', ?, '2026-08-15T00:00:00.000Z')`,
  ).run(postingId, `h-${p.externalId}`, p.score === undefined ? 40 : p.score, p.tier, p.gaps ? JSON.stringify(p.gaps) : null);
}

const NOW = () => "2026-09-01T00:00:00.000Z";

describe("buildGapsData", () => {
  it("counts reach and high-scoring no matches, and excludes low-scoring no", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    seedMatch(db, { sourceId: remote, externalId: "reach1", tier: "reach", gaps: ["Docker"] });
    seedMatch(db, { sourceId: remote, externalId: "no-high", tier: "no", score: HIGH_NO_SCORE_THRESHOLD, gaps: ["Docker"] });
    seedMatch(db, { sourceId: remote, externalId: "no-low", tier: "no", score: HIGH_NO_SCORE_THRESHOLD - 1, gaps: ["Docker"] });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    expect(data.reachCount).toBe(1);
    expect(data.highNoCount).toBe(1);
    expect(data.totalCandidates).toBe(2);
  });

  it("excludes safe and stretch tiers entirely", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    seedMatch(db, { sourceId: remote, externalId: "safe1", tier: "safe", gaps: [] });
    seedMatch(db, { sourceId: remote, externalId: "stretch1", tier: "stretch", gaps: ["Docker"] });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    expect(data.totalCandidates).toBe(0);
    expect(data.overall).toEqual([]);
  });

  it("excludes postings first seen outside the lookback window", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    const tooOld = new Date(
      new Date(NOW()).getTime() - (GAP_LOOKBACK_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    seedMatch(db, { sourceId: remote, externalId: "old", tier: "reach", gaps: ["Docker"], firstSeenAt: tooOld });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    expect(data.totalCandidates).toBe(0);
  });

  it("frequency-ranks skills across all candidates, most-blocking first", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    seedMatch(db, { sourceId: remote, externalId: "a", tier: "reach", gaps: ["Docker", "GraphQL"] });
    seedMatch(db, { sourceId: remote, externalId: "b", tier: "reach", gaps: ["Docker"] });
    seedMatch(db, { sourceId: remote, externalId: "c", tier: "reach", gaps: ["GraphQL"] });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    expect(data.overall[0]).toEqual({ skill: "Docker", count: 2 });
    expect(data.overall[1]).toEqual({ skill: "GraphQL", count: 2 });
  });

  it("splits gap frequency by market", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    const nepal = seedSource(db, "merojob", "nepal");
    seedMatch(db, { sourceId: remote, externalId: "r1", tier: "reach", gaps: ["Docker"] });
    seedMatch(db, { sourceId: nepal, externalId: "n1", tier: "reach", gaps: ["Java"] });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    expect(data.byMarket.remote).toEqual([{ skill: "Docker", count: 1 }]);
    expect(data.byMarket.nepal).toEqual([{ skill: "Java", count: 1 }]);
  });

  it("computes how many reach postings a top gap would move to stretch (<=2 total gaps)", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    // Fixing Docker leaves 0 gaps for "solo" and 1 gap for "pair" — both cross into stretch.
    seedMatch(db, { sourceId: remote, externalId: "solo", tier: "reach", gaps: ["Docker"] });
    seedMatch(db, { sourceId: remote, externalId: "pair", tier: "reach", gaps: ["Docker", "GraphQL"] });
    // Fixing Docker here still leaves 2 gaps — stays reach.
    seedMatch(db, { sourceId: remote, externalId: "triple", tier: "reach", gaps: ["Docker", "GraphQL", "Rust"] });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    const docker = data.topImpact.find((i) => i.skill === "Docker");
    expect(docker?.wouldMoveToStretch).toBe(2);
  });

  it("caps impact analysis at the top 5 overall gaps", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    const skills = ["A", "B", "C", "D", "E", "F"];
    skills.forEach((skill, i) => {
      // Descending frequency so ranking is deterministic: A most frequent, F least.
      for (let n = 0; n <= skills.length - 1 - i; n++) {
        seedMatch(db, { sourceId: remote, externalId: `${skill}-${n}`, tier: "reach", gaps: [skill] });
      }
    });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    expect(data.topImpact).toHaveLength(5);
    expect(data.topImpact.map((i) => i.skill)).not.toContain("F");
  });

  it("reports a null score no-tier match as excluded (treated as 0)", () => {
    const db = openDb(":memory:");
    const remote = seedSource(db, "remotive", "remote");
    seedMatch(db, { sourceId: remote, externalId: "n1", tier: "no", score: null, gaps: ["Docker"] });

    const data = buildGapsData(db, { now: NOW });
    db.close();

    expect(data.totalCandidates).toBe(0);
  });
});
