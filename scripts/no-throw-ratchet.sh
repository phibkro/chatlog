#!/usr/bin/env bash
# Ratchet on `throw` outside the process boundaries.
#
# WHY a ratchet and not a hard ban: control flow by exception is invisible to
# callers and to the type checker — an unhandled throw in src/adapters/codex.ts
# halted ingestion for five days (2026-07-22..27) because a new upstream item
# type was an unrecoverable error rather than a value the caller had to handle.
# The fix is typed errors. After reconciling the prerelease branch with upstream
# workflow modules written before this ratchet, the merged tree has ~216 throws.
# The count may fall, never rise. New code carries typed errors; existing throws
# convert as they are touched, and the Effect migration drives this toward zero.
#
# WHY grep and not a lint rule: oxlint has no `no-restricted-syntax`, and its
# JS plugin API is alpha. This is ~20 lines with zero dependencies and works
# today; replace it with a real rule once that API is stable.
#
# EXEMPT: the CLI and the two servers are the process boundary, where an
# unrecoverable error legitimately becomes a non-zero exit or a 500. Tests
# throw to assert.
set -euo pipefail

cd "$(dirname "$0")/.."
BASELINE_FILE="scripts/no-throw-baseline.txt"

count="$(grep -rn 'throw ' --include='*.ts' src/ 2>/dev/null \
  | grep -vE '\.test\.ts|src/cli\.ts|src/mcp/server\.ts|src/workbench/server\.ts' \
  | wc -l | tr -d ' ')"

baseline="$(tr -d ' \n' < "$BASELINE_FILE" 2>/dev/null || echo 0)"

if [ "$count" -gt "$baseline" ]; then
  echo "no-throw ratchet: $count throws, baseline $baseline — $((count - baseline)) added." >&2
  echo "Return a typed error instead. If this is genuinely a process boundary," >&2
  echo "put it in src/cli.ts or a server entry point." >&2
  grep -rn 'throw ' --include='*.ts' src/ 2>/dev/null \
    | grep -vE '\.test\.ts|src/cli\.ts|src/mcp/server\.ts|src/workbench/server\.ts' >&2
  exit 1
fi

if [ "$count" -lt "$baseline" ]; then
  echo "$count" > "$BASELINE_FILE"
  echo "no-throw ratchet: $count throws (was $baseline) — baseline tightened, commit it."
else
  echo "no-throw ratchet: $count throws, at baseline."
fi
