#!/usr/bin/env bash
# One command, end to end. Target runtime: under 2 minutes.
set -euo pipefail
cd "$(dirname "$0")"

CH_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
CH_USER="${CLICKHOUSE_USER:-default}"
CH_AUTH="$CH_USER:${CLICKHOUSE_PASSWORD:-}"
START=$(date +%s)

say() { printf '\n=== %s ===\n\n' "$1"; }

ch_ping() { curl -s --max-time 4 --user "$CH_AUTH" "$CH_URL/ping" 2>/dev/null | grep -q Ok; }

# Find credentials the server actually accepts: the env-provided password,
# the compose default (aps_demo), or empty (local binary). Exports the
# working pair so emit/verify/langfuse inherit it.
ch_resolve_auth() {
  for pw in "${CLICKHOUSE_PASSWORD:-}" "aps_demo" ""; do
    if curl -s --max-time 4 --user "$CH_USER:$pw" "$CH_URL/?query=SELECT%201" 2>/dev/null | grep -q '^1'; then
      CH_AUTH="$CH_USER:$pw"
      export CLICKHOUSE_USER="$CH_USER" CLICKHOUSE_PASSWORD="$pw"
      return 0
    fi
  done
  echo "Could not authenticate to ClickHouse at $CH_URL" >&2
  exit 1
}

ch_query_file() { curl -sS --user "$CH_AUTH" "$CH_URL/?default_format=PrettyCompactMonoBlock" --data-binary @"$1"; }

# 1. Start ClickHouse. Prefer docker compose. Fall back to a local binary.
if ch_ping; then
  say "ClickHouse already running at $CH_URL"
elif docker info >/dev/null 2>&1; then
  say "Starting ClickHouse via docker compose"
  docker compose up -d
elif [ -x bin/clickhouse ]; then
  say "Docker unavailable. Starting the local clickhouse binary"
  mkdir -p .ch-data
  (cd .ch-data && nohup ../bin/clickhouse server >server.log 2>&1 &)
else
  echo "No ClickHouse available." >&2
  echo "Either start Docker, or download the binary:" >&2
  echo "  mkdir -p bin && cd bin && curl -fsSL https://clickhouse.com/ | sh" >&2
  exit 1
fi

# 2. Wait for readiness.
for i in $(seq 1 60); do
  ch_ping && break
  [ "$i" = 60 ] && { echo "ClickHouse did not become ready in 60s" >&2; exit 1; }
  sleep 1
done
say "ClickHouse ready"
ch_resolve_auth

# 3. Apply schema. One statement per HTTP request.
python3 - <<EOF
import urllib.request
url = "$CH_URL"
sql = open('schema/aps_receipts.sql').read()
for stmt in sql.split(';'):
    body = '\n'.join(l for l in stmt.splitlines() if not l.strip().startswith('--')).strip()
    if not body:
        continue
    req = urllib.request.Request(url + '/', data=stmt.encode())
    import base64, os
    auth = os.environ.get('CLICKHOUSE_USER','default') + ':' + os.environ.get('CLICKHOUSE_PASSWORD','')
    req.add_header('Authorization', 'Basic ' + base64.b64encode(auth.encode()).decode())
    urllib.request.urlopen(req).read()
print('[schema] aps_receipts and agent_traces created')
EOF

# 4. Emit six actions as signed receipts plus trace mirror rows.
say "Emit: 6 agent actions, 5 in scope, 1 out of scope"
npx tsx src/emit.ts

# 5. Re-verify every receipt straight out of the store.
say "Verify: every signature, every column binding"
npx tsx src/verify.ts

# 6. Tamper with one row, then catch it.
say "Tamper: ALTER one row's scope, verify again"
npx tsx src/verify.ts --tamper

# 7. The money query: one JOIN finds behavior outside authority.
say "Drift query: trace vs receipt, JOIN USING action_ref"
ch_query_file queries/drift.sql

say "Bonus: receipts per agent per decision"
ch_query_file queries/receipts_per_agent.sql

say "Bonus: receipts per delegation chain root"
ch_query_file queries/delegation_roots.sql

# 8. Optional: mirror the same actions to Langfuse. Skips without env keys.
npx tsx src/langfuse.ts

say "Done in $(( $(date +%s) - START ))s"
