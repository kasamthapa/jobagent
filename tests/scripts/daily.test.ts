import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..");
const scriptPath = join(repoRoot, "scripts", "daily.sh");
const fakeCli = join(repoRoot, "tests", "fixtures", "fake-cli.sh");

function run(env: Record<string, string>): { status: number | null; logFile: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "jobagent-daily-"));
  const logFile = join(dir, "daily.log");
  const result = spawnSync("bash", [scriptPath], {
    env: { ...process.env, CLI_CMD: `bash ${fakeCli}`, LOG_FILE: logFile, ...env },
    encoding: "utf-8",
  });
  const log = readFileSync(logFile, "utf-8");
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, logFile, log };
}

describe("scripts/daily.sh", () => {
  it("exits 0 and runs poll, score, and digest in order when every stage succeeds", () => {
    const { status, log } = run({});
    expect(status).toBe(0);
    const pollIdx = log.indexOf("fake-cli: poll");
    const scoreIdx = log.indexOf("fake-cli: score");
    const digestIdx = log.indexOf("fake-cli: digest");
    expect(pollIdx).toBeGreaterThan(-1);
    expect(pollIdx).toBeLessThan(scoreIdx);
    expect(scoreIdx).toBeLessThan(digestIdx);
  });

  it("exits non-zero when the poll stage fails, but still runs score and digest", () => {
    const { status, log } = run({ FAKE_POLL_EXIT: "1" });
    expect(status).not.toBe(0);
    expect(log).toContain("fake-cli: poll");
    expect(log).toContain("fake-cli: score");
    expect(log).toContain("fake-cli: digest");
  });

  it("exits non-zero when the digest stage fails", () => {
    const { status } = run({ FAKE_DIGEST_EXIT: "1" });
    expect(status).not.toBe(0);
  });

  it("appends to the log file across runs rather than truncating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-daily-"));
    const logFile = join(dir, "daily.log");
    const env = { ...process.env, CLI_CMD: `bash ${fakeCli}`, LOG_FILE: logFile };

    spawnSync("bash", [scriptPath], { env, encoding: "utf-8" });
    spawnSync("bash", [scriptPath], { env, encoding: "utf-8" });

    const log = readFileSync(logFile, "utf-8");
    rmSync(dir, { recursive: true, force: true });

    expect(log.match(/=== daily run:/g)).toHaveLength(2);
  });
});
