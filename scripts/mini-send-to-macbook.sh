#!/usr/bin/env bash
# Mini → MacBook reverse send. MacBook must already be serving with the same pair.
# Usage:
#   PEERS_URL=http://<macbook-ts-ip>:8744 AGENT_COLLAB_PEERS_PAIR=<secret> ./scripts/mini-send-to-macbook.sh
set -euo pipefail
URL="${PEERS_URL:?set PEERS_URL=http://<macbook-ts-ip>:8744}"
PAIR="${AGENT_COLLAB_PEERS_PAIR:?set AGENT_COLLAB_PEERS_PAIR to the MacBook serve secret}"
TEXT="${PEER_TEXT:-reverse-ping-$(date -u +%Y%m%dT%H%M%SZ)}"
AUTH=(-H "authorization: Bearer ${PAIR}")

echo "=== health ==="
curl -fsS -m 15 "${AUTH[@]}" "${URL%/}/peers/health"; echo

echo "=== register mini (sender) on remote serve ==="
REG=$(curl -fsS -m 15 -X POST "${URL%/}/peers/register" \
  "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"name":"mini","harness":"cursor"}')
TOKEN=$(printf '%s' "$REG" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
FROM=$(printf '%s' "$REG" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])')

echo "=== ensure macbook peer ==="
curl -fsS -m 15 -X POST "${URL%/}/peers/register" \
  "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"name":"macbook","harness":"cursor"}' >/dev/null || true

echo "=== send $FROM -> macbook ==="
curl -fsS -m 20 -X POST "${URL%/}/peers/send" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"to\":\"macbook\",\"from\":\"$FROM\",\"text\":\"$TEXT\"}"
echo
echo "DONE $TEXT"
