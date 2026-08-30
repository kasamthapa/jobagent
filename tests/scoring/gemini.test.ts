import { describe, expect, it, vi } from "vitest";
import { applyRemotePenalty, callGemini, scoreWithGemini } from "../../src/scoring/gemini.js";
import type { PromptPosting } from "../../src/scoring/prompt.js";
import type { Profile } from "../../src/scoring/types.js";

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
    const text = await callGemini("prompt", { apiKey: "key", fetchImpl });
    expect(text).toBe('{"score": 70}');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("gemini-2.5-flash:generateContent");
    expect(url).toContain("key=key");
    expect(JSON.parse(init.body as string).contents[0].parts[0].text).toBe("prompt");
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(callGemini("prompt", { apiKey: "key", fetchImpl })).rejects.toThrow(/HTTP 429/);
  });

  it("throws when the response has no text content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(callGemini("prompt", { apiKey: "key", fetchImpl })).rejects.toThrow(/no text content/);
  });
});

describe("scoreWithGemini", () => {
  it("parses a valid strict-JSON response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiResponse(
        JSON.stringify({ score: 72, tier: "stretch", reasoning: "Good fit.", gaps: ["Docker"] }),
      ),
    );
    const result = await scoreWithGemini(posting, profile, { apiKey: "key", fetchImpl });
    expect(result).toEqual({ score: 72, tier: "stretch", reasoning: "Good fit.", gaps: ["Docker"] });
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
    const result = await scoreWithGemini(posting, profile, { apiKey: "key", fetchImpl });
    expect(result?.tier).toBe("reach");
  });

  it("retries once on malformed JSON, then succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(geminiResponse("not json"))
      .mockResolvedValueOnce(
        geminiResponse(JSON.stringify({ score: 60, tier: "stretch", reasoning: "ok", gaps: [] })),
      );
    const result = await scoreWithGemini(posting, profile, { apiKey: "key", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result?.score).toBe(60);
  });

  it("returns null after two failed attempts rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse("still not json"));
    const result = await scoreWithGemini(posting, profile, { apiKey: "key", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it("returns null when the schema doesn't match (e.g. an invalid tier)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiResponse(JSON.stringify({ score: 50, tier: "maybe", reasoning: "x", gaps: [] })),
    );
    const result = await scoreWithGemini(posting, profile, { apiKey: "key", fetchImpl });
    expect(result).toBeNull();
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
