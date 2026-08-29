import { openDb, DEFAULT_DB_PATH } from "./db/schema.js";
import { loadRegistry, DEFAULT_REGISTRY_PATH } from "./sources/registry.js";
import { upsertSource, listSources, countTables } from "./db/queries.js";

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

/** Stub — Phase 2 (remote) and Phase 3 (Nepal) add real adapter fetch logic. */
export function runPoll(flags: Record<string, string>): void {
  console.log("poll: not implemented yet (Phase 2/3 add adapter fetch logic).");
  if (flags.market) {
    console.log(`  requested market: ${flags.market}`);
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

export function main(argv: string[] = process.argv.slice(2)): void {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "init":
      runInit();
      break;
    case "poll":
      runPoll(flags);
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
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
