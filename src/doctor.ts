/**
 * `npm run cli -- doctor` (PLAN.md Phase 6): a diagnostic report, not a
 * gate. Every check catches its own failures and records them as a failed
 * `DoctorCheck` rather than throwing — an unreachable source or a missing
 * API key is exactly the kind of thing doctor exists to surface, so it must
 * never crash the command itself. cli.ts always exits 0 after printing the
 * report; a human reads it and decides what to do.
 */

import type Database from "better-sqlite3";
import { TABLE_NAMES } from "./db/schema.js";
import { checkIntegrity, listTableNames, type SourceRow } from "./db/queries.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  hasGeminiKey: boolean;
  /** Sources to probe for reachability — normally every row from `listSources`. */
  sources: SourceRow[];
  /** Overridable for tests; defaults to the real `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-source reachability timeout. Defaults to 5s. */
  timeoutMs?: number;
}

const DEFAULT_REACHABILITY_TIMEOUT_MS = 5_000;

/** `PRAGMA integrity_check` plus presence of all four core tables. */
function checkDbIntegrity(db: Database.Database): DoctorCheck {
  try {
    const summary = checkIntegrity(db);
    if (summary !== "ok") {
      return { name: "db integrity", ok: false, detail: `PRAGMA integrity_check: ${summary}` };
    }

    const tableNames = new Set(listTableNames(db));
    const missing = TABLE_NAMES.filter((t) => !tableNames.has(t));
    if (missing.length > 0) {
      return { name: "db integrity", ok: false, detail: `missing table(s): ${missing.join(", ")}` };
    }

    return { name: "db integrity", ok: true, detail: "ok, all tables present" };
  } catch (err) {
    return { name: "db integrity", ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkGeminiKey(hasKey: boolean): DoctorCheck {
  return hasKey
    ? { name: "GEMINI_API_KEY", ok: true, detail: "present" }
    : { name: "GEMINI_API_KEY", ok: false, detail: "not set — `score` will skip LLM scoring" };
}

/** A lightweight GET probe for one source's URL. Never throws — failure is the result, not an exception. */
async function checkSourceReachable(
  source: SourceRow,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const name = `source:${source.name}`;
  if (!source.url) {
    return { name, ok: true, detail: "no url configured (skipped)" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(source.url, { method: "GET", signal: controller.signal });
    // A 4xx here often just means "no User-Agent"/"needs a real client", which
    // the adapter itself already sends — this is a reachability probe, not a
    // full adapter run, so only 5xx/network failure counts as unreachable.
    return res.status >= 500
      ? { name, ok: false, detail: `HTTP ${res.status}` }
      : { name, ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    const detail = controller.signal.aborted
      ? `timed out after ${timeoutMs / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return { name, ok: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every doctor check and returns the full report. Sources are probed sequentially, one poll's worth of politeness at a time. */
export async function runDoctorChecks(db: Database.Database, opts: DoctorOptions): Promise<DoctorReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REACHABILITY_TIMEOUT_MS;

  const checks: DoctorCheck[] = [checkDbIntegrity(db), checkGeminiKey(opts.hasGeminiKey)];
  for (const source of opts.sources.filter((s) => s.active === 1)) {
    checks.push(await checkSourceReachable(source, fetchImpl, timeoutMs));
  }
  return { checks };
}

/** Formats a report for console output: one line per check, then a pass/fail tally. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = ["Doctor report:", ""];
  for (const c of report.checks) {
    lines.push(`[${c.ok ? "OK" : "FAIL"}] ${c.name} — ${c.detail}`);
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  lines.push("", `${report.checks.length - failed}/${report.checks.length} checks passed.`);
  return lines.join("\n");
}
