#!/usr/bin/env bash
# Unattended daily run: poll, score, digest, in sequence. Every stage runs
# even if an earlier one fails (a failed poll shouldn't skip digesting
# whatever's already scored), but the script exits non-zero if any stage
# failed. Output is appended (never truncated) to logs/daily.log. See
# PLAN.md Phase 5.
#
# CLI_CMD and LOG_FILE are overridable so tests/scripts/daily.test.ts can
# swap in a test double for `npm run cli` and a scratch log path instead of
# the real ones. $CLI_CMD is deliberately left unquoted below — it's meant
# to word-split (e.g. "npm run cli --" or "bash some/fixture.sh").
set -uo pipefail

cd "$(dirname "$0")/.."
CLI_CMD="${CLI_CMD:-npm run cli --}"
LOG_FILE="${LOG_FILE:-logs/daily.log}"

mkdir -p "$(dirname "$LOG_FILE")"

{
  echo "=== daily run: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  status=0

  echo "--- poll ---"
  $CLI_CMD poll || status=1

  echo "--- score ---"
  $CLI_CMD score || status=1

  echo "--- digest ---"
  $CLI_CMD digest || status=1

  echo "=== daily run finished with status ${status}: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  exit "${status}"
} >> "$LOG_FILE" 2>&1
