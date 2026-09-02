import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDigestState, saveDigestState } from "../../src/digest/state.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobagent-digest-state-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadDigestState", () => {
  it("reads lastDigestAt: null when the file doesn't exist yet", () => {
    const path = join(tmpDir(), "state.json");
    expect(loadDigestState(path)).toEqual({ lastDigestAt: null });
  });

  it("reads back a previously saved timestamp", () => {
    const path = join(tmpDir(), "nested", "state.json");
    saveDigestState({ lastDigestAt: "2026-08-01T00:00:00.000Z" }, path);
    expect(loadDigestState(path)).toEqual({ lastDigestAt: "2026-08-01T00:00:00.000Z" });
  });

  it("treats malformed JSON as never-run rather than throwing", () => {
    const path = join(tmpDir(), "state.json");
    writeFileSync(path, "{not json");
    expect(loadDigestState(path)).toEqual({ lastDigestAt: null });
  });

  it("treats a missing lastDigestAt field as never-run", () => {
    const path = join(tmpDir(), "state.json");
    writeFileSync(path, JSON.stringify({ somethingElse: true }));
    expect(loadDigestState(path)).toEqual({ lastDigestAt: null });
  });
});
