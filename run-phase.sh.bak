#!/usr/bin/env bash
# run-phase.sh — run the next todo phase from PLAN.md, with hard gates.
#
#   ./run-phase.sh            run the next todo phase
#   ./run-phase.sh --all      run until a phase fails or all are done
#   ./run-phase.sh --review   review last commits, no changes
#
# The agent's claim that a phase passed is NOT trusted. This script
# re-verifies the gate, checks the test count did not shrink, and reverts
# the phase to `todo` if verification fails.

set -uo pipefail
mkdir -p logs out

# ---- billing separation -------------------------------------------------
# Uncomment to bill agent runs to the API instead of your subscription,
# keeping your chat quota free. Key stays scoped to this script only.
# export ANTHROPIC_API_KEY="sk-ant-..."

MODEL="${MODEL:-sonnet}"
PHASE_TIMEOUT="${PHASE_TIMEOUT:-2700}"   # 45 min hard wall clock per phase
MAX_PHASES=1
[[ "${1:-}" == "--all" ]] && MAX_PHASES=7

ALLOWED=(
  "Read" "Edit" "Write" "Glob" "Grep" "WebFetch" "WebSearch"
  "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(tsx:*)"
  "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push)"
  "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)"
  "Bash(git checkout -b:*)" "Bash(mkdir:*)" "Bash(cat:*)" "Bash(ls:*)"
)
DENIED=(
  "Bash(rm:*)" "Bash(sudo:*)" "Bash(git push --force:*)"
  "Bash(git reset:*)" "Bash(git rebase:*)" "Bash(git checkout -- :*)"
  "Bash(chmod:*)" "Bash(dd:*)" "Bash(curl:*-o*)"
)

test_count() { npx vitest list --run 2>/dev/null | grep -c "" || echo 0; }

current_phase() {
  grep -n "^Status: todo" PLAN.md | head -1 | cut -d: -f1
}

gate_for_phase() {
  # Gate commands, indexed by phase number.
  case "$1" in
    1) echo "npm test && npm run cli -- init" ;;
    2) echo "npm test && npm run cli -- poll --market remote" ;;
    3) echo "npm test && npm run cli -- poll" ;;
    4) echo "npm test && npm run cli -- score" ;;
    5) echo "npm test && npm run cli -- digest" ;;
    6) echo "npm test && npm run cli -- doctor" ;;
    7) echo "npm test && npm run cli -- gaps" ;;
  esac
}

run_one() {
  local line num name before_tests before_sha
  line=$(current_phase)
  if [[ -z "$line" ]]; then echo "All phases done."; return 100; fi
  name=$(head -n "$line" PLAN.md | grep "^## Phase" | tail -1)
  num=$(echo "$name" | grep -oE '[0-9]+' | head -1)
  echo "=== Phase $num: $name ==="

  before_tests=$(test_count)
  before_sha=$(git rev-parse HEAD 2>/dev/null || echo "none")

  timeout --signal=INT "$PHASE_TIMEOUT" \
  claude -p "Read PLAN.md. Implement the lowest-numbered phase whose Status \
is 'todo', following every rule in 'Rules for every phase'. Run the phase \
gate yourself. If it fails 3 times, STOP, write logs/blocked-${num}.md, and \
leave Status as todo. Never weaken, skip, or delete a test to make a gate \
pass — if a test is genuinely wrong, explain why in logs/decisions.md \
before changing it." \
    --model "$MODEL" \
    --permission-mode dontAsk \
    --allowedTools "${ALLOWED[@]}" \
    --disallowedTools "${DENIED[@]}" \
    --output-format json \
    > "logs/run-p${num}-$(date +%s).json" 2>> logs/stderr.log
  local agent_rc=$?

  if [[ $agent_rc -eq 124 ]]; then
    echo "TIMEOUT after ${PHASE_TIMEOUT}s. Phase $num incomplete."
  fi

  # ---- independent verification. the agent's word counts for nothing ----
  echo "--- verifying gate independently ---"
  local gate; gate=$(gate_for_phase "$num")
  if ! eval "$gate" > "logs/gate-p${num}.log" 2>&1; then
    echo "GATE FAILED. See logs/gate-p${num}.log"
    sed -i.bak "${line}s/^Status: done/Status: todo/" PLAN.md 2>/dev/null
    return 1
  fi

  local after_tests; after_tests=$(test_count)
  if (( after_tests < before_tests )); then
    echo "TEST COUNT DROPPED ($before_tests -> $after_tests). Suspicious."
    echo "Reverting phase to todo. Inspect: git diff $before_sha..HEAD"
    sed -i.bak "${line}s/^Status: done/Status: todo/" PLAN.md 2>/dev/null
    return 1
  fi

  if grep -qiE "co-authored-by: claude|generated with \[?claude" \
       <(git log "$before_sha"..HEAD --format=%B 2>/dev/null); then
    echo "WARNING: AI attribution found in commit messages. Fix before push."
    return 1
  fi

  echo "Phase $num verified. tests: $before_tests -> $after_tests"
  return 0
}

review_last() {
  claude -p "Review the most recent commits against PLAN.md. Check: (1) code \
belonging to a LATER phase, (2) SQL outside src/db/queries.ts, (3) new \
functions with no test, (4) tests that would still pass if the function body \
were emptied, (5) hardcoded secrets, (6) AI attribution in commits. Report \
file:line. Do NOT edit anything." \
    --model "$MODEL" --permission-mode dontAsk \
    --allowedTools "Read" "Grep" "Glob" "Bash(git diff:*)" "Bash(git log:*)" \
    --output-format json 2>/dev/null \
  | jq -r '.result' > "out/review-$(date +%F-%H%M).md"
  echo "Review -> out/review-$(date +%F-%H%M).md"
}

[[ "${1:-}" == "--review" ]] && { review_last; exit 0; }

for ((i=0; i<MAX_PHASES; i++)); do
  run_one; rc=$?
  [[ $rc -eq 100 ]] && break
  [[ $rc -ne 0 ]] && { echo "Stopped at phase failure. Nothing further run."; exit $rc; }
  review_last
done
echo "Done. Reviews in out/, run records in logs/."