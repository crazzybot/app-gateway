#!/usr/bin/env bash
# =============================================================================
# scripts/hooks/test-runner.sh — PostToolUse: Automatic test runner
# =============================================================================
# PURPOSE:
#   After Claude writes or edits a source file, run the Vitest suite scoped to
#   that file's directory (this is a single-package project — no npm
#   workspaces to route between). This hook is informational only — it NEVER
#   blocks (always exits 0).
#
# INVOCATION (from .claude/settings.json):
#   bash scripts/hooks/test-runner.sh "$CLAUDE_TOOL_INPUT_PATH"
#
#   $1 — path of the file that was just written/edited
#
# EXIT CODES:
#   0  — always (PostToolUse hooks must not block)
# =============================================================================

# Do not use set -e — we must always exit 0
set -uo pipefail

FILE_PATH="${1:-}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo "🧪  [test-runner] $*"; }
skipped() { echo "⏭️   [test-runner] Skipped — $*"; exit 0; }

# ---------------------------------------------------------------------------
# Guard: no file path provided
# ---------------------------------------------------------------------------
if [[ -z "$FILE_PATH" ]]; then
  skipped "no file path provided"
fi

# ---------------------------------------------------------------------------
# Guard: only run tests for TypeScript source files
# ---------------------------------------------------------------------------
case "$FILE_PATH" in
  *.ts)
    # Source file — proceed
    ;;
  *)
    skipped "not a TypeScript source file: ${FILE_PATH}"
    ;;
esac

# ---------------------------------------------------------------------------
# Guard: skip generated/build output and drizzle migration artefacts
# ---------------------------------------------------------------------------
case "$FILE_PATH" in
  */dist/*|*/node_modules/*)
    skipped "file is in a build/dependency directory: ${FILE_PATH}"
    ;;
  */db/migrations/*)
    skipped "file is a generated Drizzle migration (run npm run db:migrate to apply, not test): ${FILE_PATH}"
    ;;
esac

# ---------------------------------------------------------------------------
# Determine the related test scope from the file path
# ---------------------------------------------------------------------------
NORMALISED_PATH="$(echo "$FILE_PATH" | sed 's|^\./||')"

case "$NORMALISED_PATH" in
  tests/unit/*|tests/integration/*|tests/e2e/*)
    # Editing a test file directly — run that file
    SCOPE="$NORMALISED_PATH"
    ;;
  src/*)
    # Derive a resource keyword from the file name to scope the run
    # (e.g. src/services/token.service.ts -> "token")
    BASENAME="$(basename "$NORMALISED_PATH")"
    SCOPE="${BASENAME%%.*}"
    ;;
  *)
    skipped "file does not belong to src/ or tests/: ${FILE_PATH}"
    ;;
esac

# ---------------------------------------------------------------------------
# Run tests
# ---------------------------------------------------------------------------
info "File edited : ${FILE_PATH}"
info "Test scope  : ${SCOPE}"
info "Running     : npm test -- ${SCOPE}"
echo ""

# Locate the project root (directory containing package.json)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "$PROJECT_ROOT" || {
  echo "⚠️   [test-runner] Could not cd to project root: ${PROJECT_ROOT}"
  exit 0
}

# Run tests — capture exit code but always exit 0 ourselves
# Vitest treats a bare positional argument as a filename substring filter,
# not a Jest-style --testPathPattern flag.
if npm test -- "$SCOPE" 2>&1; then
  echo ""
  echo "✅  [test-runner] Tests passed for scope: ${SCOPE}"
else
  TEST_EXIT=$?
  echo ""
  echo "❌  [test-runner] Tests FAILED for scope: ${SCOPE} (exit ${TEST_EXIT})"
  echo "    Review failures above before committing."
  echo "    Run manually: npm test -- ${SCOPE}"
fi

# PostToolUse hooks must always exit 0
exit 0
