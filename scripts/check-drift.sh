#!/usr/bin/env bash
# Drift check: blocks commits that contain internal patterns or private paths.
# Install: ln -sf ../../scripts/check-drift.sh .git/hooks/pre-commit
# Bypass with: git commit --no-verify (use sparingly, document why).

set -euo pipefail

# Patterns that BLOCK the commit if found in staged content or filenames.
HARD_BLOCK_PATTERNS=(
  'aeoess-private'
  '/Users/tima'
  'MODEL-CITIZEN-CANON'
  'MODEL_CITIZEN_CANON'
  'THE-SYNTHESIS'
  'THE_SYNTHESIS'
  'OPEN-COMMITMENTS'
  'OPEN_COMMITMENTS'
  'CC-PROMPT'
  'CC_PROMPT'
  'DAILY-UPDATE-RHYTHM'
  'DAILY_UPDATE_RHYTHM'
  'MUTUAL-MODE'
  'MUTUAL_MODE'
  'UPDATE-PROPAGATION-SPEC'
  'ProxyGateway'
  'aeoess/gateway'
)

# Patterns that WARN but allow the commit. Reviewer judgment territory.
SOFT_WARN_PATTERNS=(
  'gateway'
  'internal doc'
)

# Files exempted from the hook.
EXEMPT_FILES=(
  '.gitignore'
  'scripts/check-drift.sh'
)

is_exempt() {
  local f="$1"
  for ex in "${EXEMPT_FILES[@]}"; do
    [ "$f" = "$ex" ] && return 0
  done
  return 1
}

staged=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$staged" ] && exit 0

violations=0
warnings=0

while IFS= read -r file; do
  is_exempt "$file" && continue
  [ -f "$file" ] || continue

  for pat in "${HARD_BLOCK_PATTERNS[@]}"; do
    if [[ "$file" == *"$pat"* ]]; then
      echo "  x filename '$file' contains forbidden pattern: $pat" >&2
      violations=$((violations + 1))
    fi
  done

  for pat in "${HARD_BLOCK_PATTERNS[@]}"; do
    if git diff --cached "$file" 2>/dev/null | grep -E "^\+" | grep -F "$pat" > /dev/null 2>&1; then
      lines=$(git diff --cached "$file" 2>/dev/null | grep -E "^\+" | grep -F "$pat" | head -3)
      echo "  x $file: forbidden pattern '$pat' in staged content:" >&2
      echo "$lines" | sed 's/^/      /' >&2
      violations=$((violations + 1))
    fi
  done

  for pat in "${SOFT_WARN_PATTERNS[@]}"; do
    if git diff --cached "$file" 2>/dev/null | grep -E "^\+" | grep -F "$pat" > /dev/null 2>&1; then
      lines=$(git diff --cached "$file" 2>/dev/null | grep -E "^\+" | grep -F "$pat" | head -2)
      echo "  ! $file: review-needed pattern '$pat' in staged content:" >&2
      echo "$lines" | sed 's/^/      /' >&2
      warnings=$((warnings + 1))
    fi
  done
done <<< "$staged"

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "x drift check: $violations violation(s) blocked commit." >&2
  echo "  Fix the issues above, or bypass with: git commit --no-verify" >&2
  exit 1
fi

if [ "$warnings" -gt 0 ]; then
  echo "" >&2
  echo "! drift check: $warnings soft warning(s). Commit allowed." >&2
fi

exit 0
