#!/usr/bin/env bash
# =============================================================================
# scripts/hooks/secret-scan-file.sh — PreToolUse: File write secret scanner
# =============================================================================
# PURPOSE:
#   Guards against writing files that either (a) target a sensitive path
#   (e.g. .env, *.pem, *credentials*) or (b) contain hardcoded secrets in
#   their content.  Blocks the write by exiting 2 if a violation is found.
#
# INVOCATION (from .claude/settings.json):
#   bash scripts/hooks/secret-scan-file.sh "$CLAUDE_TOOL_INPUT_PATH" "$CLAUDE_TOOL_INPUT_CONTENT"
#
#   $1  — target file path
#   $2  — file content (may be empty; hook also reads stdin if content is large)
#
# EXIT CODES:
#   0  — no violation detected (write proceeds)
#   2  — violation detected (write BLOCKED)
# =============================================================================

set -euo pipefail

FILE_PATH="${1:-}"
FILE_CONTENT="${2:-}"

# ---------------------------------------------------------------------------
# Nothing to scan
# ---------------------------------------------------------------------------
if [[ -z "$FILE_PATH" && -z "$FILE_CONTENT" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Helper: emit a block message and exit 2
# ---------------------------------------------------------------------------
block() {
  local reason="$1"
  local detail="${2:-}"
  echo "" >&2
  echo "╔══════════════════════════════════════════════════════════════════╗" >&2
  echo "║  🔐  SECRET SCAN BLOCKED — File write rejected                   ║" >&2
  echo "╚══════════════════════════════════════════════════════════════════╝" >&2
  echo "" >&2
  echo "  Hook  : scripts/hooks/secret-scan-file.sh" >&2
  echo "  File  : ${FILE_PATH}" >&2
  echo "  Reason: ${reason}" >&2
  if [[ -n "$detail" ]]; then
    echo "  Detail: ${detail}" >&2
  fi
  echo "" >&2
  echo "  ✋ Secrets must never be written to files that are tracked by git." >&2
  echo "     Use .env files (gitignored) and load them at runtime." >&2
  echo "" >&2
  echo "  See CLAUDE.md §Security Rules for the project security policy." >&2
  echo "" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Part 1 — Sensitive path check
# ---------------------------------------------------------------------------
# Normalise path to basename + full path for matching
BASENAME="$(basename "$FILE_PATH")"
LOWER_PATH="$(echo "$FILE_PATH" | tr '[:upper:]' '[:lower:]')"

SENSITIVE_PATH_PATTERNS=(
  # Real .env files (not .env.example / .env.sample / .env.test)
  '^\.env$'
  '\.env\.(production|staging|prod|live)$'
  '/\.env$'
  # Key / certificate files
  '\.pem$'
  '\.key$'
  '\.p12$'
  '\.pfx$'
  '\.crt$'
  '\.cer$'
  # Files whose name contains sensitive words
  'credentials'
  'secret'
  'passwd'
  'shadow'
  'id_rsa'
  'id_ed25519'
  'id_ecdsa'
  '\.keystore$'
)

for pat in "${SENSITIVE_PATH_PATTERNS[@]}"; do
  if echo "$LOWER_PATH" | grep -qP "$pat" 2>/dev/null; then
    block \
      "Target path matches a sensitive file pattern: ${pat}" \
      "Writing to '${FILE_PATH}' is not allowed by the secret-scan hook."
  fi
done

# ---------------------------------------------------------------------------
# Part 2 — Content secret scan
# ---------------------------------------------------------------------------
# Collect content: from $2 if provided, otherwise from stdin
if [[ -z "$FILE_CONTENT" ]]; then
  if [[ ! -t 0 ]]; then
    FILE_CONTENT="$(cat -)"
  fi
fi

if [[ -z "$FILE_CONTENT" ]]; then
  exit 0
fi

CONTENT_PATTERNS=(
  # AWS
  'AKIA[0-9A-Z]{16}'
  'aws_secret_access_key\s*[:=]\s*\S+'
  # Private keys
  '-----BEGIN (RSA|EC|DSA|OPENSSH|PGP|PRIVATE) KEY'
  # GitHub / GitLab / NPM / Slack tokens
  'ghp_[a-zA-Z0-9]{36}'
  'gho_[a-zA-Z0-9]{36}'
  'github_pat_[a-zA-Z0-9_]{82}'
  'glpat-[a-zA-Z0-9\-_]{20}'
  'npm_[a-zA-Z0-9]{36}'
  'xox[baprs]-[0-9a-zA-Z\-]+'
  # Stripe
  'sk_(live|test)_[a-zA-Z0-9]{24,}'
  # Generic high-value assignments (not placeholder/example values)
  # Matches: SECRET=abc123... but NOT SECRET=your-secret-here or SECRET=<secret>
  '(PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|PRIVATE_KEY)\s*[:=]\s*(?!your-|<|example|placeholder|changeme|replace|xxxx|dummy|test-|dev-)[^$\s<>|&;'"'"'"]{12,}'
  # Connection strings with embedded passwords
  'postgresql://[^:]+:[^@]{6,}@(?!localhost|127\.0\.0\.1|postgres)'
  'mysql://[^:]+:[^@]{6,}@(?!localhost|127\.0\.0\.1|mysql)'
  # Generic high-entropy strings next to key-like labels (base64/hex, len>=32)
  '(secret|token|api.?key|password|credential)\s*[:=]\s*['\''"]?[a-zA-Z0-9+/]{32,}={0,2}['\''"]?'
)

MATCHED_CONTENT_PATTERN=""
for pattern in "${CONTENT_PATTERNS[@]}"; do
  if echo "$FILE_CONTENT" | grep -qiP "$pattern" 2>/dev/null; then
    MATCHED_CONTENT_PATTERN="$pattern"
    break
  fi
done

if [[ -n "$MATCHED_CONTENT_PATTERN" ]]; then
  block \
    "File content contains a hardcoded secret pattern." \
    "Pattern matched: ${MATCHED_CONTENT_PATTERN}"
fi

exit 0
