import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, DEFAULT_REGISTRY_PATH } from "../../src/sources/registry.js";

const tmpDirs: string[] = [];

function writeRegistry(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "jobagent-registry-"));
  tmpDirs.push(dir);
  const path = join(dir, "sources.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadRegistry", () => {
  it("parses a valid registry", () => {
    const path = writeRegistry([
      { name: "remotive", market: "remote", kind: "api", url: "https://x.test", adapter: "remotive", active: true },
      { name: "merojob", market: "nepal", kind: "portal", url: "https://y.test", adapter: "merojob", active: true },
    ]);
    const sources = loadRegistry(path);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.name).toBe("remotive");
  });

  it("allows a null url (unverifiable careers pages)", () => {
    const path = writeRegistry([
      { name: "some-co", market: "nepal", kind: "careers", url: null, adapter: "careers-generic", active: false },
    ]);
    expect(loadRegistry(path)[0]?.url).toBeNull();
  });

  it("rejects an entry with an invalid market", () => {
    const path = writeRegistry([
      { name: "bad", market: "atlantis", kind: "portal", url: "https://x.test", adapter: "a", active: true },
    ]);
    expect(() => loadRegistry(path)).toThrow();
  });

  it("rejects an entry with an invalid kind", () => {
    const path = writeRegistry([
      { name: "bad", market: "nepal", kind: "blog", url: "https://x.test", adapter: "a", active: true },
    ]);
    expect(() => loadRegistry(path)).toThrow();
  });

  it("rejects an entry missing a required field", () => {
    const path = writeRegistry([{ market: "nepal", kind: "portal", url: "https://x.test", adapter: "a", active: true }]);
    expect(() => loadRegistry(path)).toThrow();
  });

  it("rejects malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-registry-"));
    tmpDirs.push(dir);
    const path = join(dir, "sources.json");
    writeFileSync(path, "{ not json");
    expect(() => loadRegistry(path)).toThrow();
  });

  it("defaults to data/sources.json and loads the real project registry", () => {
    const sources = loadRegistry(DEFAULT_REGISTRY_PATH);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(["nepal", "remote"]).toContain(source.market);
    }
  });
});
