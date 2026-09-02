import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, DEFAULT_DB_PATH } from "./db/schema.js";
import { loadRegistry, DEFAULT_REGISTRY_PATH } from "./sources/registry.js";
import {
  upsertSource,
  listSources,
  countTables,
  recordPollResult,
  listOpenPostings,
  type SourceRow,
} from "./db/queries.js";
import { adapters } from "./sources/adapters/index.js";
import { applyPoll } from "./pipeline/upsert.js";
import { computeDedupeGroups, countDuplicates } from "./pipeline/dedupe.js";
import { loadProfile, DEFAULT_PROFILE_PATH } from "./scoring/profile.js";
import { scorePostings } from "./scoring/scorer.js";
import { buildDigestData } from "./digest/build.js";
import { renderDigestMarkdown } from "./digest/render.js";
import { loadDigestState, saveDigestState, DEFAULT_DIGEST_STATE_PATH } from "./digest/state.js";
import type { Market, Source } from "./sources/types.js";

export const DEFAULT_OUT_DIR = "out";

/** A `SourceRow` is a `Source` plus id/health columns — adapters only need the `Source` shape. */
function toSource(row: SourceRow): Source {
  return {
    name: row.name,
    market: row.market,
    kind: row.kind,
    url: row.url,
    adapter: row.adapter,
    active: row.active === 1,
  };
}

const COMMANDS = ["init", "poll", "score", "digest"] as const;
type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
  command: Command;
  flags: Record<string, string>;
}

/** Parses `argv` (already sliced past `node script.js`) into a command + `--flag value` pairs. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!isCommand(command)) {
    throw new Error(
      `Unknown command: ${command ?? "(none)"}. Expected one of: ${COMMANDS.join(", ")}.`,
    );
  }

  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      const hasValue = next !== undefined && !next.startsWith("--");
      flags[key] = hasValue ? next : "true";
      if (hasValue) i++;
    }
  }
  return { command, flags };
}

function isCommand(value: string | undefined): value is Command {
  return !!value && (COMMANDS as readonly string[]).includes(value);
}

/**
 * Creates/opens the DB, applies the schema, and loads data/sources.json
 * into the `sources` table. Idempotent — safe to run repeatedly.
 */
export function runInit(
  dbPath: string = DEFAULT_DB_PATH,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): void {
  const db = openDb(dbPath);
  try {
    const sources = loadRegistry(registryPath);
    for (const source of sources) {
      upsertSource(db, source);
    }

    const counts = countTables(db);
    const loaded = listSources(db);
    const activeCount = loaded.filter((s) => s.active).length;

    console.log(`Initialized ${dbPath}`);
    console.log(
      `Tables: ${Object.entries(counts)
        .map(([table, n]) => `${table}=${n}`)
        .join(", ")}`,
    );
    console.log(
      `Loaded ${loaded.length} sources from ${registryPath} (${activeCount} active, ${
        loaded.length - activeCount
      } inactive).`,
    );
  } finally {
    db.close();
  }
}

function isMarket(value: string | undefined): value is Market {
  return value === "nepal" || value === "remote";
}

/**
 * Polls every active, adapter-implemented source (optionally filtered by
 * `--market`), upserts its postings, and updates the source's poll-health
 * columns. A source whose adapter throws is logged to `sources.last_error`
 * and skipped — one broken source never aborts the whole poll (this is the
 * normal case for Nepal scrapers: a selector matching 0 elements is an
 * error, not an empty result, and leaves previously-seen postings alone).
 * Finishes by grouping every open posting by `dedupe_key` and printing how
 * many collapsed as duplicates of the same job posted on multiple sources.
 */
export async function runPoll(
  flags: Record<string, string>,
  dbPath: string = DEFAULT_DB_PATH,
): Promise<void> {
  if (flags.market !== undefined && !isMarket(flags.market)) {
    throw new Error(`Unknown market: ${flags.market}. Expected "nepal" or "remote".`);
  }
  const marketFilter = flags.market;

  const db = openDb(dbPath);
  try {
    const sources = listSources(db).filter(
      (s) => s.active === 1 && (!marketFilter || s.market === marketFilter),
    );

    let totalPostings = 0;
    for (const source of sources) {
      const adapter = adapters[source.adapter];
      if (!adapter) {
        console.log(`${source.name}: no adapter implemented yet, skipping`);
        continue;
      }

      const polledAt = new Date().toISOString();
      try {
        const postings = await adapter.fetch(toSource(source));
        const result = applyPoll(db, source.id, source.market, postings, polledAt);
        recordPollResult(db, source.id, polledAt, postings.length, null);
        totalPostings += postings.length;
        console.log(
          `${source.name}: ${postings.length} postings ` +
            `(inserted ${result.inserted}, updated ${result.updated}, closed ${result.closed})`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordPollResult(db, source.id, polledAt, null, message);
        console.log(`${source.name}: ERROR - ${message}`);
      }
    }

    console.log(`Polled ${sources.length} source(s), ${totalPostings} total postings.`);

    const openPostings = listOpenPostings(db);
    const groups = computeDedupeGroups(openPostings);
    const duplicates = countDuplicates(groups);
    console.log(
      `Deduped ${openPostings.length} open posting(s) into ${groups.length} unique job(s) ` +
        `(${duplicates} duplicate(s) collapsed).`,
    );
  } finally {
    db.close();
  }
}

/**
 * Scores every open posting that hasn't already been scored against its
 * current content_hash: a cheap prefilter first, then Gemini for survivors.
 * Without a `GEMINI_API_KEY` in the environment, LLM scoring is skipped and
 * every prefilter survivor is recorded as unscored (score/tier = null)
 * rather than failing the whole command — the prefilter pass still runs and
 * still populates `matches`.
 */
export async function runScore(
  dbPath: string = DEFAULT_DB_PATH,
  profilePath: string = DEFAULT_PROFILE_PATH,
): Promise<void> {
  const db = openDb(dbPath);
  try {
    const profile = loadProfile(profilePath);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log(
        "GEMINI_API_KEY not set — skipping LLM scoring; prefilter still runs and unscored matches are recorded.",
      );
    }

    const summary = await scorePostings(db, {
      profile,
      gemini: apiKey ? { apiKey } : null,
    });

    const cacheTotal = summary.cacheHits + summary.cacheMisses;
    const hitRate = cacheTotal === 0 ? 0 : Math.round((summary.cacheHits / cacheTotal) * 100);

    console.log(
      `Considered ${summary.totalOpen} open posting(s): ${summary.cacheHits} cache hit(s), ` +
        `${summary.cacheMisses} cache miss(es) (${summary.prefilterDropped} dropped by prefilter, ` +
        `${summary.llmScored} scored by Gemini, ${summary.llmFailed} unscored).`,
    );
    console.log(`Cache hit rate: ${summary.cacheHits}/${cacheTotal} (${hitRate}%).`);
    console.log(
      `Tier distribution: safe=${summary.tierCounts.safe}, stretch=${summary.tierCounts.stretch}, ` +
        `reach=${summary.tierCounts.reach}, no=${summary.tierCounts.no}, unscored=${summary.tierCounts.unscored}.`,
    );
  } finally {
    db.close();
  }
}

/**
 * Writes `out/digest-YYYY-MM-DD.md`: every open, scored posting first seen
 * since the last digest run, grouped by tier (stretch first), plus a
 * closing-soon list and a source health table. Advances the digest's
 * last-run marker (`data/digest-state.json`) on success so the next run
 * only reports what's new since this one.
 */
export function runDigest(
  dbPath: string = DEFAULT_DB_PATH,
  statePath: string = DEFAULT_DIGEST_STATE_PATH,
  outDir: string = DEFAULT_OUT_DIR,
  now: () => string = () => new Date().toISOString(),
): void {
  const db = openDb(dbPath);
  try {
    const state = loadDigestState(statePath);
    const data = buildDigestData(db, { since: state.lastDigestAt, now });
    const markdown = renderDigestMarkdown(data);

    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `digest-${data.generatedAt.slice(0, 10)}.md`);
    writeFileSync(outPath, markdown);
    saveDigestState({ lastDigestAt: data.generatedAt }, statePath);

    console.log(`Wrote ${outPath}`);
    console.log(
      `${data.totalNew} new posting(s) since ${state.lastDigestAt ?? "(first run)"}, ` +
        `${data.closingSoon.length} closing within 7 days.`,
    );
  } finally {
    db.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "init":
      runInit();
      break;
    case "poll":
      await runPoll(flags);
      break;
    case "score":
      await runScore();
      break;
    case "digest":
      runDigest();
      break;
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
