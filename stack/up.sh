#!/usr/bin/env bash
# Boots the local mirror. Every run starts from an empty chain.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
. "$here/env.sh"
work="$root/.stack"
compose=(docker compose -f "$here/docker-compose.yml")

docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }
mkdir -p "$work"

if [ ! -f "$work/sidecar/.vajra-patched" ]; then
  echo "fetching the sidecar at $SIDECAR_COMMIT and applying docs/upstream/sidecar-budget-010.patch"
  rm -rf "$work/sidecar"
  git clone -q --filter=blob:none "$SIDECAR_REPO" "$work/sidecar"
  git -C "$work/sidecar" checkout -q "$SIDECAR_COMMIT"
  git -C "$work/sidecar" apply "$root/docs/upstream/sidecar-budget-010.patch"
  touch "$work/sidecar/.vajra-patched"
fi
# Opt-in: a copy of the sidecar with docs/upstream/sidecar-reputation.patch on top. The mirror's default stays what JUDGES.md says it is.
if [ -n "${VAJRA_SIDECAR_RULE:-}" ]; then
  rm -rf "$work/sidecar-rule"
  mkdir -p "$work/sidecar-rule"
  tar -C "$work/sidecar/" --exclude=./node_modules --exclude=./.git -cf - . | tar -C "$work/sidecar-rule" -xf -
  patch -s -d "$work/sidecar-rule" -p1 < "$root/docs/upstream/sidecar-reputation.patch"
  export VAJRA_SIDECAR_DIR=sidecar-rule VAJRA_SIDECAR_IMAGE=vajra-sidecar:2e22ff0-budget010-rule
fi
[ -f "$work/jwt.hex" ] || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' > "$work/jwt.hex"

"${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true

# Each boot is a new chain, so nothing an old one left behind may survive it: not addresses, not accounts, not notes.
rm -rf "$root/.vajra-local"
mkdir -p "$root/.vajra-local"
printf '%s' "$GENESIS_KEY" > "$root/.vajra-local/deployer.key"

"${compose[@]}" up -d --build --quiet-pull

rpc() { curl -s -m 3 "$1" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}"; }
for _ in $(seq 1 120); do
  rpc http://127.0.0.1:$VAJRA_SIDECAR_PORT/rpc/ eth_chainId | grep -q 0x343a && [ "$(rpc http://127.0.0.1:$VAJRA_RPC_PORT eth_blockNumber | grep -c '"0x[1-9a-f]')" = 1 ] && break
  sleep 1
done
rpc http://127.0.0.1:$VAJRA_SIDECAR_PORT/rpc/ eth_chainId | grep -q 0x343a || { echo "the sidecar did not come up" >&2; "${compose[@]}" logs --tail 30 sidecar >&2; exit 1; }
rpc http://127.0.0.1:$VAJRA_RPC_PORT eth_blockNumber | grep -q '"0x[1-9a-f]' || { echo "no blocks are being made" >&2; "${compose[@]}" logs --tail 30 miner ethrex >&2; exit 1; }
echo "mirror up: ethrex http://127.0.0.1:18545, alt mempool http://127.0.0.1:14337/rpc/, explorer http://127.0.0.1:18080"
