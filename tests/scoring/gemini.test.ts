import { describe, expect, it, vi } from "vitest";
import {
  applyRemotePenalty,
  callGemini,
  createRateLimiter,
  GeminiTimeoutError,
  scoreWithGemini,
} from "../../src/scoring/gemini.js";
import type { PromptPosting } from "../../src/scoring/prompt.js";
import type { Profile } from "../../src/scoring/types.js";

/** Skips the real 2s retry backoff so retry tests run instantly. */
const noDelay = async () => {};

/**
 * Skips real rate-limit waits in tests that aren't testing the rate limiter
 * itself — without this, every call in this file would otherwise share
 * gemini.ts's module-level default limiter and pile up real multi-second
 * delays across tests.
 */
const noRateLimit = { wait: async () => {} };

const profile: Profile = {
  solid: ["React", "TypeScript"],
  working: ["Supabase/pgvector"],
  learning: ["DSA"],
  next: ["Docker"],
  constraints: {
    location: "Nepal (UTC+5:45)",
    workVisa: false,
    eligibility: "worldwide or contractor-eligible remote roles only",
    level: "entry/junior level only",
  },
};

const posting: PromptPosting = {
  title: "Junior Full-Stack Developer",
  description: "Build things with React and Node.",
  market: "remote",
  location: "Anywhere",
  locationPolicy: "worldwide",
  timezoneRequirement: null,
};

function geminiResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  };
}

describe("callGemini", () => {
  it("posts the prompt and returns the response's text part", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse('{"score": 70}'));
    const text = await callGemini("prompt", { apiKey: "key", fetchImpl, rateLimiter: noRateLimit });
    expect(text).toBe('{"score": 70}');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("gemini-3.6-flash:generateContent");
    expect(url).toContain("key=key");
    expect(JSON.parse(init.body as string).contents[0].parts[0].text).toBe("prompt");
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(
      callGemini("prompt", { apiKey: "key", fetchImpl, rateLimiter: noRateLimit }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("throws when the response has no text content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(
      callGemini("prompt", { apiKey: "key", fetchImpl, rateLimiter: noRateLimit }),
    ).rejects.toThrow(/no text content/);
  });

  it("aborts and throws GeminiTimeoutError when the request never resolves", async () => {
    // Mimics real fetch's contract with AbortSignal: the promise only settles
    // once the signal aborts, otherwise it hangs forever.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    await expect(
      callGemini("prompt", {
        apiKey: "key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
        rateLimiter: noRateLimit,
      }),
    ).rejects.toThrow(GeminiTimeoutError);
  });
});

describe("createRateLimiter", () => {
  it("spaces out calls to at least 60_000/rpm ms apart", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createRateLimiter(8); // 7500ms between requests
      await limiter.wait();

      let secondResolved = false;
      const second = limiter.wait().then(() => {
        secondResolved = true;
      });

      await vi.advanceTimersByTimeAsync(7000);
      expect(secondResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(600);
      await second;
      expect(secondResolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on the very first call", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createRateLimiter(8);
      let resolved = false;
      const first = limiter.wait().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await first;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scoreWithGemini", () => {
  it("parses a valid strict-JSON response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiResponse(
        JSON.stringify({ score: 72, tier: "stretch", reasoning: "Good fit.", gaps: ["Docker"] }),
      ),
    );
    const result = await scoreWithGemini(posting, profile, { apiKey: "key", fetchImpl, rateLimiter: noRateLimit });
    expect(result).toEqual({
      ok: true,
      value: { score: 72, tier: "stretch", reasoning: "Good fit.", gaps: ["Docker"] },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("strips markdown code fences before parsing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiResponse(
        "```json\n" +
          JSON.stringify({ score: 50, tier: "reach", reasoning: "Some gaps.", gaps: ["Docker", "CI/CD"] }) +
          "\n```",
      ),
    );
    const result = await scoreWithGemini(posting, profile, { apiKey: "key", fetchImpl, rateLimiter: noRateLimit });
    expect(result).toMatchObject({ ok: true, value: { tier: "reach" } });
  });

  it("retries once on malformed JSON, then succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(geminiResponse("not json"))
      .mockResolvedValueOnce(
        geminiResponse(JSON.stringify({ score: 60, tier: "stretch", reasoning: "ok", gaps: [] })),
      );
    const result = await scoreWithGemini(posting, profile, {
      apiKey: "key",
      fetchImpl,
      delayImpl: noDelay,
      rateLimiter: noRateLimit,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, value: { score: 60 } });
  });

  it("returns a failure outcome after two failed attempts rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse("still not json"));
    const result = await scoreWithGemini(posting, profile, {
      apiKey: "key",
      fetchImpl,
      delayImpl: noDelay,
      rateLimiter: noRateLimit,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
  });

  it("returns a failure outcome when the schema doesn't match (e.g. an invalid tier)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiResponse(JSON.stringify({ score: 50, tier: "maybe", reasoning: "x", gaps: [] })),
    );
    const result = await scoreWithGemini(posting, profile, {
      apiKey: "key",
      fetchImpl,
      delayImpl: noDelay,
      rateLimiter: noRateLimit,
    });
    expect(result.ok).toBe(false);
  });

  it("times out on a hanging request, retries once, and reports a timeout error rather than hanging the run", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await scoreWithGemini(posting, profile, {
      apiKey: "key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
      delayImpl: noDelay,
      rateLimiter: noRateLimit,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/timed out/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/timed out/));
    consoleError.mockRestore();
  });

  it("reports a rate-limit failure that includes the HTTP status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const result = await scoreWithGemini(posting, profile, {
      apiKey: "key",
      fetchImpl,
      delayImpl: noDelay,
      rateLimiter: noRateLimit,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("429");
  });
});

describe("applyRemotePenalty", () => {
  const base = { score: 70, tier: "stretch" as const, reasoning: "Good fit.", gaps: ["Docker"] };

  it("deducts a flat penalty and notes it in the reasoning for a remote posting", () => {
    const penalized = applyRemotePenalty(base, "remote");
    expect(penalized.score).toBe(55);
    expect(penalized.reasoning).toContain("remote penalty");
    expect(penalized.tier).toBe("stretch");
  });

  it("never drops the score below zero", () => {
    const penalized = applyRemotePenalty({ ...base, score: 5 }, "remote");
    expect(penalized.score).toBe(0);
  });

  it("leaves a Nepal-market result unchanged", () => {
    const penalized = applyRemotePenalty(base, "nepal");
    expect(penalized).toEqual(base);
  });
});
