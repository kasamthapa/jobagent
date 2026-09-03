# CLAUDE.md

## Project purpose

A personal CLI that finds junior/entry full-stack developer roles, scores
them against a fixed owner profile, and writes a ranked markdown digest.
No auto-applying, no web UI — this is a filter and a career signal, not a
bot. See `PLAN.md` for the full phase-by-phase build plan; this file is the
standing reference for how the codebase is organized and how to work in it.

## The two-market distinction

The tool covers two job markets that are ingested completely differently:

- **`nepal`** — companies here do not use standard ATS platforms
  (Greenhouse/Lever/Ashby). Postings live on local job portals (merojob,
  kumarijob, jobsnepal, jobaxle) and on individual company careers pages.
  Ingestion is cheerio-based HTML scraping: brittle, rate-limited (1
  req/sec, never parallel against one host), and expected to partially fail
  — a selector matching 0 elements is treated as an error, not an empty
  result.
- **`remote`** — real JSON/RSS APIs (Remotive, Arbeitnow, RemoteOK,
  Himalayas, We Work Remotely RSS, HN "Who is Hiring") plus per-company ATS
  APIs later. No scraping. Every remote posting must be filtered for
  worldwide/contractor eligibility, because the owner is based in Nepal with
  no work visa and cannot take US-only/EU-only roles or roles requiring full
  US timezone overlap.

Every `source` row and every `RawPosting` carries a `market` so this
distinction is enforced at the data layer, not just in adapter code.

## Stack

Node 20+ (in practice: `better-sqlite3` only ships Node 22+ prebuilds — see
`logs/decisions.md`), TypeScript strict, `better-sqlite3`, `tsx`, `vitest`,
`zod`, `cheerio`. No web framework, no ORM, no frontend, no vector DB, no
Docker (yet). Run the CLI with `npm run cli -- <command>`, tests with
`npm test`.

## Schema summary (`src/db/schema.ts`)

- **sources** — one row per configured source (`data/sources.json`), tracks
  poll health (`last_polled_at`, `last_result_count`, `last_error`,
  `consecutive_zero_polls`). `consecutive_zero_polls` increments on any poll
  that comes back with 0 results or an error, and resets on the first poll
  with >0 results; the digest opens with a loud warning once a source
  crosses `ZERO_RESULT_ALERT_THRESHOLD` (3) — a silently broken
  parser/selector is the main failure mode of this whole system.
  `market ∈ {nepal, remote}`, `kind ∈ {portal, careers, api, rss, ats}`.
- **companies** — normalized company records, linked from `postings`.
- **postings** — one row per posting, deduped by `(source_id, external_id)`
  (UNIQUE). `content_hash = sha256(title + description)` skips re-scoring
  unchanged postings; `dedupe_key = normalized(company + title)` collapses
  the same job appearing on multiple portals. `location_policy ∈
  {worldwide, region_locked, unknown}`. `is_open` flips to 0 when a posting
  drops out of a source's latest successful poll.
- **matches** — one row per scored posting. `tier ∈ {safe, stretch, reach,
  no}` — `stretch` is the target zone (leans on `working`/`learning`
  skills from `data/profile.json`).

**All raw SQL lives in `src/db/schema.ts` (DDL) and `src/db/queries.ts`
(typed query functions). No other module — CLI, pipeline, adapters, scoring
— writes SQL directly.** `foreign_keys` and `journal_mode = WAL` are set on
every `openDb()` call.

## Adapters

Every source adapter (`src/sources/adapters/*.ts`) implements the
`JobSource` interface in `src/sources/types.ts` and **must ship a vitest
test using recorded fixtures** (`tests/fixtures/`) — never hit the network
in tests. The standard for a new adapter test: after writing it, deliberately
break the adapter and confirm the test fails for the right reason, then
restore. A passing test that was never seen to fail proves nothing.

## Networking and diagnostics

Every outbound HTTP call — remote adapters' `fetchJson`/`fetchText`
(`src/sources/adapters/shared.ts`), Nepal's `fetchHtml`
(`src/sources/adapters/nepal-shared.ts`), and Gemini's `callGemini`
(`src/scoring/gemini.ts`) — times out and retries once with backoff on a
network error, a timeout, or a 429/5xx response. The first two share
`src/net/http.ts`'s `fetchWithRetry`; Gemini has its own (quota-aware, 2s
backoff) version since it predates it. `npm run cli -- doctor` prints a
health report (DB integrity, `GEMINI_API_KEY` presence, per-source
reachability) and always exits 0 — it's a diagnostic, not a gate.

## Gap report

`npm run cli -- gaps` turns the tool from a filter into a career signal: it
looks at every `reach`-tier and high-scoring `no`-tier match (score ≥
`HIGH_NO_SCORE_THRESHOLD`, 50 — a low-scoring `no` is usually wrong-level or
wrong-discipline noise, not a real skill gap) from postings first seen in the
last `GAP_LOOKBACK_DAYS` (90) days, frequency-ranks the skills in `gaps`
across all of them, splits that ranking by market (Nepal and remote want
different things), and for the top 5 gaps reports how many `reach` postings
would cross into `stretch` if that one skill closed. Writes
`out/gaps-YYYY-MM-DD.md`. Pure data assembly (`src/gaps/build.ts`) /
rendering (`src/gaps/render.ts`) split, same as `digest`.

## Commit conventions

Conventional commits: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. One
commit per logical unit of work, not one commit per phase.

**Never add `Co-Authored-By` lines, "Generated with Claude Code" footers,
emoji robot lines, or any other AI attribution to commits, PR bodies, branch
names, or any git metadata. This is non-negotiable.**

Never force-push, never rewrite history, never `rm -rf`, never touch `.env`
or commit secrets.
