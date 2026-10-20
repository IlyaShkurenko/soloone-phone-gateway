#!/usr/bin/env bash
# Runs the dry-run screen check on the test phone and prints its report. Exit code 1 on any failed check.
set -u
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh >/dev/null 2>&1 || true
nvm use 22.13.1 >/dev/null 2>&1 || true
log=$(mktemp)
node dist/selftest.js --from "$1" --to "$2" --react-text "${3:-}" > "$log" 2>&1
rc=$?
grep -vE '^\{"level":30' "$log"
rm -f "$log"
exit $rc
