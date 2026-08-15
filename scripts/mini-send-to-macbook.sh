#!/usr/bin/env bash
# Mini → MacBook reverse send. MacBook must already be serving.
# Usage:
#   PEERS_URL=http://<macbook-tailscale-ip>:8744 ./scripts/mini-send-to-macbook.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${PEERS_URL:?set PEERS_URL=http://<macbook-ts-ip>:8744}"
TEXT="${PEER_TEXT:-reverse-ping-$(date -u +%Y%m%dT%H%M%SZ)}"
export AGENT_COLLAB_PEERS_URL="$URL"

echo "=== health ==="
curl -fsS -m 15 "${URL%/}/peers/health"; echo

echo "=== register mini (sender) on remote serve ==="
REG=$(curl -fsS -m 15 -X POST "${URL%/}/peers/register" -H 'content-type: application/json' \
  -d '{"name":"mini","harness":"cursor"}')
TOKEN=$(printf '%s' "$REG" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
FROM=$(printf '%s' "$REG" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])')

echo "=== ensure macbook peer ==="
curl -fsS -m 15 -X POST "${URL%/}/peers/register" -H 'content-type: application/json' \
  -d '{"name":"macbook","harness":"cursor"}' >/dev/null || true

echo "=== send $FROM -> macbook ==="
curl -fsS -m 20 -X POST "${URL%/}/peers/send" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"to\":\"macbook\",\"from\":\"$FROM\",\"text\":\"$TEXT\"}"
echo
echo "DONE $TEXT"
