# PLAN.md — Job Matching Agent

You are implementing this project one PHASE at a time. Each run handles
exactly ONE phase: the lowest-numbered phase whose Status is `todo`.

## Rules for every phase

1. Read this whole file, then work only on your assigned phase.
2. Do NOT implement anything from a later phase. Scope creep fails the run.
3. Write tests alongside code. A phase is not done until its gate passes.
4. Run the gate command yourself. If it fails, fix and re-run, max 3 attempts.
   After 3 failures: STOP, write the failure to `logs/blocked-<phase>.md`
   explaining what you tried, and exit non-zero. Do not mark the phase done.
5. On success: mark the phase `Status: done` in this file, commit, push.
6. Commit style: conventional commits (`feat:`, `fix:`, `test:`, `chore:`,
   `docs:`). One commit per logical unit, not one commit per phase.
7. **NEVER** add `Co-Authored-By` lines, "Generated with Claude Code"
   footers, emoji robot lines, or any AI attribution to commits, PR bodies,
   branch names, or any git metadata. This is non-negotiable.
8. Never force-push. Never rewrite history. Never `rm -rf`. Never touch
   `.env` or commit secrets.
9. If a decision is genuinely ambiguous, pick the simpler option, write the
   choice and reasoning into `logs/decisions.md`, and continue. Do not stall.

## Project

A personal CLI that finds junior/entry full-stack developer roles across two
markets, scores them against a fixed profile, and emits a ranked digest.
No auto-applying. No web UI. Output is markdown.

**Owner profile lives in `data/profile.json` (Phase 4). Summary:**
BCA student in Nepal (UTC+5:45), no work visa, seeking first developer role.
Two deployed projects: a peer-review platform (React/TS/Node/Express/
Postgres/Prisma/JWT) and a RAG app over GitHub repos (Express/TS, Supabase
pgvector, Gemini embeddings + LLM, SSE streaming, AST chunking, Vitest).

## Stack

Node 20+, TypeScript strict, better-sqlite3, tsx, vitest, zod, cheerio.
No web framework. No ORM. No frontend. No vector DB. No Docker (yet).

## Markets

- `nepal` — companies do NOT use Greenhouse/Lever/Ashby. Roles live on
  portals and company careers pages. HTML scraping with cheerio.
- `remote` — real JSON/RSS APIs plus per-company ATS APIs. No scraping.
  Must filter for worldwide/contractor eligibility: the owner cannot take
  US-only or EU-only roles, and cannot do full US timezone overlap.

---

## Phase 1 — Scaffold

Status: done

Goal: repo skeleton, DB schema, source registry, CLI entrypoint.

Build:

```
src/db/schema.ts        idempotent table creation
src/db/queries.ts       typed query fns; NO SQL anywhere else in the codebase
src/sources/types.ts    JobSource interface + RawPosting + Source types
src/sources/registry.ts loads data/sources.json
src/cli.ts              subcommands: init, poll, score, digest
data/sources.json
logs/                   gitignored except .gitkeep
CLAUDE.md
```

Schema:

```
sources(id, name, market, kind, url, adapter, active,
        last_polled_at, last_result_count, last_error)
companies(id, name, market, careers_url, ats_type, ats_token, created_at)
postings(id, source_id, company_id, external_id, title, description, url,
         location, location_policy, timezone_requirement, salary_text,
         posted_at, deadline, first_seen_at, last_seen_at, is_open,
         content_hash, dedupe_key)
matches(id, posting_id, score, tier, reasoning, gaps_json, scored_at)
```

- `market` in ('nepal','remote')
- `kind` in ('portal','careers','api','rss','ats')
- `location_policy` in ('worldwide','region_locked','unknown')
- `tier` in ('safe','stretch','reach','no')
- UNIQUE(source_id, external_id) on postings
- `content_hash` = sha256(title + description) — used to skip re-scoring
- `dedupe_key` = normalized(company + title) — same job appears on multiple
  portals and must collapse
- foreign_keys ON, journal_mode WAL

Interface (define, do not implement):

```ts
interface JobSource {
  name: string;
  market: "nepal" | "remote";
  kind: "portal" | "careers" | "api" | "rss" | "ats";
  fetch(source: Source): Promise<RawPosting[]>;
}
```

`data/sources.json` seed:

```
remote / api|rss:
  https://remotive.com/api/remote-jobs?category=software-dev
  https://www.arbeitnow.com/api/job-board-api
  https://remoteok.com/api
  https://himalayas.app/jobs/api
  https://weworkremotely.com/categories/remote-programming-jobs.rss
  https://hn.algolia.com/api/v1/   (Who is Hiring)
nepal / portal:
  https://merojob.com/category/it-telecommunication
  https://www.kumarijob.com/job-listing/it-jobs-in-nepal
  https://www.jobsnepal.com/category/information-technology-jobs
  https://jobaxle.com
nepal / careers — resolve each real URL yourself; "url": null if unverifiable,
and list the failures in logs/decisions.md. DO NOT invent URLs:
  Leapfrog Technology (https://www.lftechnology.com/careers), F1Soft,
  Fusemachines, Cotiviti Nepal, Deerwalk, Cedar Gate, Verisk Nepal,
  Yarsa Labs, Docsumo, Khalti, eSewa, Vairav, Rooster Logic,
  Young Innovations, SoftNEP, Raralabs
```

`CLAUDE.md` must contain: project purpose, the two-market distinction, stack,
schema summary, commit conventions including the no-attribution rule, and the
rule that every source adapter needs a vitest test.

DO NOT: implement any fetch logic, scoring, or digest.

Gate: `npm test && npm run cli -- init` exits 0 and creates `data/jobs.db`
with all four tables and sources.json loaded.

---

## Phase 2 — Remote adapters

Status: done

Goal: working ingestion from the remote JSON/RSS sources.

Build one adapter per remote source in `src/sources/adapters/`. Each:

- validates the response with zod before touching the DB
- maps to `RawPosting`
- infers `location_policy`: 'worldwide' unless the posting names a required
  country/region/timezone, then 'region_locked'
- extracts `timezone_requirement` as free text when present
- fails soft: one broken source logs to `sources.last_error` and does not
  abort the whole poll

Also: `src/pipeline/upsert.ts` — insert-or-update by (source_id,
external_id), compute content_hash and dedupe_key, set first_seen_at once
and last_seen_at every time, mark is_open=0 for postings not seen in the
latest successful poll of that source.

Each adapter gets a vitest test using recorded fixture JSON in
`tests/fixtures/`. Do NOT hit the network in tests — stub fetch.

**Testing standard: after writing each test, deliberately break the source
function and confirm the test fails for the RIGHT reason. Then restore.
A passing test proves nothing on its own.**

DO NOT: implement Nepal scrapers, scoring, or digest.

Gate: `npm test && npm run cli -- poll --market remote` exits 0, writes >0
postings, and prints a per-source count summary.

---

## Phase 3 — Nepal adapters + dedupe

Status: done

Goal: ingestion from Nepali portals and careers pages.

Cheerio-based scrapers, one per portal. These are brittle by nature:

- set a real User-Agent, 1 request/sec max, never parallel-hammer a host
- if a selector matches 0 elements, that is an ERROR not an empty result —
  record it in `sources.last_error` and keep the previous data
- careers pages vary wildly; write a generic heuristic extractor and accept
  that some will return nothing. Log which ones.

Then `src/pipeline/dedupe.ts`: collapse postings sharing a `dedupe_key`,
keeping the earliest `first_seen_at` and preferring the source with the
richest description. Record the alternates so the digest can show all links.

Vitest tests use saved HTML fixtures, not live pages.

DO NOT: implement scoring or digest.

Gate: `npm test && npm run cli -- poll` exits 0 across both markets and
prints a dedupe count.

---

## Phase 4 — Profile + scorer

Status: done

Goal: score every unscored posting against the owner profile.

`data/profile.json` — skills in explicit tiers:

```
solid:    React, TypeScript, Node, Express, PostgreSQL, Prisma, REST,
          JWT auth (access+refresh, httpOnly cookies), Git
working:  Supabase/pgvector, raw pg client, Gemini API, SSE streaming,
          Vitest, AST parsing, Cloudinary, Vite
learning: test design and mocking, DSA (NeetCode, JavaScript)
next:     Docker, CI/CD
constraints: based in Nepal UTC+5:45, no work visa, needs worldwide or
          contractor-eligible for remote roles, entry/junior level only
```

`src/scoring/` — for each posting with no current match row (or whose
content_hash changed):

1. Cheap prefilter, no LLM: drop senior/lead/principal/manager titles, drop
   non-engineering roles, drop remote roles where location_policy is
   'region_locked' and the region excludes Nepal. Log how many were dropped.
2. LLM scoring on survivors via Gemini (`gemini-3.6-flash`). Return strict
   JSON: `{score: 0-100, tier, reasoning, gaps: string[]}`.
   - `safe` — needs only `solid` skills
   - `stretch` — leans on `working` + `learning`; THIS IS THE TARGET ZONE
   - `reach` — needs 2+ skills the owner does not have
   - `no` — wrong level, wrong discipline, or ineligible
     Use a low temperature. Validate the JSON with zod; retry once on parse
     failure, then record score=null and move on.
3. Never re-score an unchanged content_hash. Log cache hit rate.

Remote roles are scored with a stricter bar than Nepal roles — junior remote
international hiring is far more competitive. Apply a penalty to remote
scores and note it in the reasoning.

DO NOT: implement the digest.

Gate: `npm test && npm run cli -- score` exits 0, populates `matches`, and
prints tier distribution + cache hit rate.

---

## Phase 5 — Digest + scheduling

Status: done

Goal: human-readable output and unattended operation.

`npm run cli -- digest` writes `out/digest-YYYY-MM-DD.md`:

- new postings since last digest, grouped by tier, `stretch` first
- each entry: title, company, market, score, one-line reasoning, gaps,
  link(s), deadline if known
- a "closing soon" section for deadlines within 7 days
- a source health table: last poll time, count, any errors

Also `scripts/daily.sh` — poll, score, digest in sequence, with a
non-zero exit if any stage fails, and output appended to `logs/daily.log`.

Gate: `npm test && npm run cli -- digest` exits 0 and produces a non-empty
markdown file.

---

## Phase 6 — Hardening

Status: done

Goal: make it survivable.

- Tests for every untested module. Target: every pure function covered.
- Source health alert: if a source returns 0 results 3 polls in a row, the
  digest opens with a loud warning. Silent parser death is the main failure
  mode of this whole system.
- Rate limit + retry with backoff on all network calls.
  - Gemini rate limiting + retry already implemented in Phase 4 (see commits
    13e893e, 9080836) — Phase 6 should extend this pattern to the other
    adapters (portal/careers/API sources), not redo Gemini.
- Graceful handling of: malformed HTML, API schema changes, network timeouts,
  Gemini quota errors.
- `npm run cli -- doctor` — checks DB integrity, source reachability, API key
  presence, and prints a health report.

Gate: `npm test` passes with every module having at least one test, and
`npm run cli -- doctor` exits 0.

---

## Phase 7 — Gap report

Status: done

Goal: turn the tool from a filter into a career signal.

`npm run cli -- gaps` analyses all `reach` and high-scoring `no` postings
from the last 90 days and outputs `out/gaps-YYYY-MM-DD.md`:

- skills blocking the owner, frequency-ranked across the whole target market
- split by market (what Nepal wants vs what remote wants — these differ)
- for the top 5 gaps: how many additional roles would move from `reach` to
  `stretch` if that skill moved to `working`

This is the output that tells the owner what to learn next, based on the
actual market rather than a listicle.

Gate: `npm test && npm run cli -- gaps` exits 0 and produces a non-empty
markdown file.
