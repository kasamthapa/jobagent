import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, FetchTimeoutError } from "../../src/net/http.js";

function jsonResponse(ok: boolean, status: number, headers: Record<string, string> = {}): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe("fetchWithRetry", () => {
  it("returns a successful response on the first attempt without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(true, 200));
    const res = await fetchWithRetry("https://x.test", {}, { fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable error status like 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(false, 404));
    const res = await fetchWithRetry("https://x.test", {}, { fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 503 and returns the eventual success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(false, 503))
      .mockResolvedValueOnce(jsonResponse(true, 200));
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    const res = await fetchWithRetry("https://x.test", {}, { fetchImpl, delayImpl });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delayImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the last response after retries are exhausted, without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(false, 503));
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    const res = await fetchWithRetry("https://x.test", {}, { fetchImpl, delayImpl, retries: 1 });

    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honors a numeric Retry-After header over the default backoff", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(false, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(true, 200));
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    await fetchWithRetry("https://x.test", {}, { fetchImpl, delayImpl, backoffMs: 50 });

    expect(delayImpl).toHaveBeenCalledWith(2000);
  });

  it("retries once on a network-level rejection then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(true, 200));
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    const res = await fetchWithRetry("https://x.test", {}, { fetchImpl, delayImpl });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws the underlying error once retries are exhausted", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      fetchWithRetry("https://x.test", {}, { fetchImpl, delayImpl, retries: 1 }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws FetchTimeoutError when every attempt is aborted for taking too long", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as unknown as typeof fetch;
      const delayImpl = vi.fn().mockResolvedValue(undefined);

      const promise = fetchWithRetry("https://x.test", {}, {
        fetchImpl,
        delayImpl,
        retries: 0,
        timeoutMs: 1_000,
      });
      const assertion = expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
