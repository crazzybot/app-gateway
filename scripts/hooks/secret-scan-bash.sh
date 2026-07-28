#!/usr/bin/env bash
# =============================================================================
# scripts/hooks/secret-scan-bash.sh — PreToolUse: Bash secret scanner
# =============================================================================
# PURPOSE:
#   Scans the bash command string (passed as $1) for patterns that indicate
#   a secret, credential, or API key is being embedded directly in the
#   command.  If a match is found, exits 2 to BLOCK the tool use.
#
# INVOCATION (from .claude/settings.json):
#   bash scripts/hooks/secret-scan-bash.sh "$CLAUDE_TOOL_INPUT"
#
# EXIT CODES:
#   0  — no secrets detected (tool use proceeds)
#   2  — secret pattern detected (tool use BLOCKED)
# =============================================================================

set -euo pipefail

COMMAND="${1:-}"

# ---------------------------------------------------------------------------
# Nothing to scan
# ---------------------------------------------------------------------------
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Secret patterns — add new patterns here as threats evolve
# ---------------------------------------------------------------------------
declare -a PATTERNS=(
  # AWS
  'AKIA[0-9A-Z]{16}'                         # AWS access key ID
  'aws_secret_access_key\s*=\s*\S+'          # AWS secret key assignment
  'AWS_SECRET_ACCESS_KEY\s*=\s*\S+'          # AWS secret key env var
  'AWS_SESSION_TOKEN\s*=\s*\S+'              # AWS session token
  # Private keys / certificates
  '-----BEGIN (RSA|EC|DSA|OPENSSH|PGP|PRIVATE) KEY'
  # Generic secret/token env-var assignments (KEY=value patterns)
  '(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|PRIVATE_KEY)\s*=\s*['\''"][^'\''"\s]{8,}['\''"]'
  # Generic secret/token env-var assignments (unquoted)
  '(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|PRIVATE_KEY)\s*=\s*[^$\s<>|&;'"'"'"]{8,}'
  # GitHub / GitLab / NPM / Slack tokens
  'ghp_[a-zA-Z0-9]{36}'                     # GitHub PAT (classic)
  'gho_[a-zA-Z0-9]{36}'                     # GitHub OAuth
  'github_pat_[a-zA-Z0-9_]{82}'             # GitHub fine-grained PAT
  'glpat-[a-zA-Z0-9\-_]{20}'               # GitLab PAT
  'npm_[a-zA-Z0-9]{36}'                     # npm token
  'xox[baprs]-[0-9a-zA-Z\-]+'              # Slack token
  # Stripe
  'sk_(live|test)_[a-zA-Z0-9]{24,}'         # Stripe secret key
  # Twilio
  'SK[0-9a-fA-F]{32}'                       # Twilio auth token
  # Generic high-entropy base64/hex blobs next to key-like words
  '(secret|token|key|password|credential)[_-]?[:=]['\'' ]*[a-zA-Z0-9+/]{32,}={0,2}'
  # curl/wget with Authorization header carrying a token
  '-H\s+['\''"]?Authorization:\s*Bearer\s+[a-zA-Z0-9\-_.~+/]{20,}'
  # psql/mysql connection strings with embedded password
  'postgresql://[^:]+:[^@]{6,}@'
  'mysql://[^:]+:[^@]{6,}@'
)

# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------
FOUND=0
MATCHED_PATTERN=""

for pattern in "${PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qiP "$pattern" 2>/dev/null; then
    FOUND=1
    MATCHED_PATTERN="$pattern"
    break
  fi
done

# ---------------------------------------------------------------------------
# Report and exit
# ---------------------------------------------------------------------------
if [[ "$FOUND" -eq 1 ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗" >&2
  echo "║  🔐  SECRET SCAN BLOCKED — Potential credential detected         ║" >&2
  echo "╚══════════════════════════════════════════════════════════════════╝" >&2
  echo "" >&2
  echo "  Hook  : scripts/hooks/secret-scan-bash.sh" >&2
  echo "  Reason: The bash command contains a pattern that matches a known" >&2
  echo "          secret / credential format." >&2
  echo "" >&2
  echo "  Pattern matched: ${MATCHED_PATTERN}" >&2
  echo "" >&2
  echo "  ✋ DO NOT embed secrets directly in shell commands." >&2
  echo "     Use environment variables loaded from .env files instead:" >&2
  echo "" >&2
  echo "     # Bad  : export MY_TOKEN=ghp_abc123..." >&2
  echo "     # Good : export MY_TOKEN=\$MY_TOKEN  (value comes from .env)" >&2
  echo "" >&2
  echo "  See CLAUDE.md §Security Rules for the project security policy." >&2
  echo "" >&2
  exit 2
fi

exit 0
