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
import type { Market, Source } from "./sources/types.js";

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

/** Stub — Phase 4 adds the scorer. */
export function runScore(): void {
  console.log("score: not implemented yet (Phase 4 adds the scorer).");
}

/** Stub — Phase 5 adds the digest writer. */
export function runDigest(): void {
  console.log("digest: not implemented yet (Phase 5 adds the digest writer).");
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
      runScore();
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
