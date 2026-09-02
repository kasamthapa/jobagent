import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DIGEST_STATE_PATH = "data/digest-state.json";

export interface DigestState {
  /** ISO timestamp of the last successful digest run, or null before the first one. */
  lastDigestAt: string | null;
}

/**
 * Reads the digest's last-run marker. A missing or malformed file reads as
 * "never run" rather than throwing — the first digest should show every
 * open, scored posting as new, not crash.
 */
export function loadDigestState(path: string = DEFAULT_DIGEST_STATE_PATH): DigestState {
  if (!existsSync(path)) return { lastDigestAt: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const lastDigestAt =
      typeof parsed === "object" && parsed !== null && typeof (parsed as { lastDigestAt?: unknown }).lastDigestAt === "string"
        ? (parsed as { lastDigestAt: string }).lastDigestAt
        : null;
    return { lastDigestAt };
  } catch {
    return { lastDigestAt: null };
  }
}

/** Persists the digest's last-run marker, creating the parent directory if needed. */
export function saveDigestState(state: DigestState, path: string = DEFAULT_DIGEST_STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
