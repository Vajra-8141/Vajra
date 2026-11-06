#!/usr/bin/env bash
# Starts the sidecar as deployed, at the same commit as the patched one, beside it on port 14338.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
work="$(dirname "$here")/.stack"
if [ ! -d "$work/sidecar-unpatched/.git" ]; then
  git clone -q --filter=blob:none "$SIDECAR_REPO" "$work/sidecar-unpatched"
  git -C "$work/sidecar-unpatched" checkout -q "$SIDECAR_COMMIT"
fi
docker compose -f "$here/docker-compose.yml" --profile compare up -d --build sidecar-unpatched
for _ in $(seq 1 60); do
  curl -s -m 3 "http://127.0.0.1:$VAJRA_UNPATCHED_PORT/rpc/" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q 0x343a && { echo "unpatched sidecar up: http://127.0.0.1:$VAJRA_UNPATCHED_PORT/rpc/"; exit 0; }
  sleep 1
done
echo "the unpatched sidecar did not come up" >&2
exit 1
