#!/usr/bin/env bash
# Test double for `npm run cli --`, used by tests/scripts/daily.test.ts to
# drive scripts/daily.sh without touching the network or the real DB. Reads
# per-stage exit codes from env vars so tests can simulate a failing stage.
cmd="$1"
echo "fake-cli: ${cmd}"
case "$cmd" in
  poll) exit "${FAKE_POLL_EXIT:-0}" ;;
  score) exit "${FAKE_SCORE_EXIT:-0}" ;;
  digest) exit "${FAKE_DIGEST_EXIT:-0}" ;;
  *) exit 1 ;;
esac
