import { describe, expect, it } from "vitest";
import { adapters } from "../../../src/sources/adapters/index.js";
import { loadRegistry, DEFAULT_REGISTRY_PATH } from "../../../src/sources/registry.js";

describe("adapters registry", () => {
  it("maps every key to an object exposing name/market/kind/fetch", () => {
    expect(Object.keys(adapters).length).toBeGreaterThan(0);
    for (const [key, adapter] of Object.entries(adapters)) {
      expect(adapter.name, key).toBeTruthy();
      expect(["nepal", "remote"]).toContain(adapter.market);
      expect(["portal", "careers", "api", "rss", "ats"]).toContain(adapter.kind);
      expect(typeof adapter.fetch).toBe("function");
    }
  });

  it("has an implementation for every adapter name referenced by data/sources.json", () => {
    const sources = loadRegistry(DEFAULT_REGISTRY_PATH);
    const missing = sources.filter((s) => !adapters[s.adapter]).map((s) => `${s.name} (${s.adapter})`);
    // careers-generic covers every "careers" source (see careers-generic.ts) —
    // anything else missing here means poll would silently skip a configured source.
    expect(missing).toEqual([]);
  });
});
