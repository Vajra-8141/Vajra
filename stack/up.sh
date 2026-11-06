#!/usr/bin/env bash
# Boots the local mirror: ethrex, a block producer, and the sidecar with docs/upstream/sidecar-budget-010.patch applied.
# Every run starts from an empty chain.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
. "$here/env.sh"
work="$root/.stack"
mkdir -p "$work/logs"
"$here/down.sh" >/dev/null 2>&1 || true

rpc() { curl -s -m 3 "127.0.0.1:$1" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}"; }

# --- the sidecar, patched and built once ---
if [ ! -f "$work/sidecar/.vajra-built" ]; then
  echo "building the sidecar at $SIDECAR_COMMIT with the patch"
  [ -d "$work/sidecar/.git" ] || git clone -q --filter=blob:none "$SIDECAR_REPO" "$work/sidecar"
  git -C "$work/sidecar" checkout -q -f "$SIDECAR_COMMIT"
  git -C "$work/sidecar" clean -fdq -e node_modules
  git -C "$work/sidecar" apply "$root/docs/upstream/sidecar-budget-010.patch"
  (cd "$work/sidecar" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)
  touch "$work/sidecar/.vajra-built"
fi

# --- ethrex ---
[ -f "$work/jwt.hex" ] || openssl rand -hex 32 > "$work/jwt.hex"
docker run -d --name vajra-ethrex --network host \
  -v "$here/genesis.json:/genesis.json:ro" -v "$work/jwt.hex:/jwt.hex:ro" "$ETHREX_IMAGE" \
  --network /genesis.json --datadir /tmp/chain \
  --http.addr 127.0.0.1 --http.port "$RPC_PORT" --http.api eth,net,web3,ethrex,debug,admin,txpool \
  --authrpc.addr 127.0.0.1 --authrpc.port "$ENGINE_PORT" --authrpc.jwtsecret /jwt.hex \
  --syncmode full --p2p.port "$P2P_PORT" --discovery.port "$P2P_PORT" --log.level info >/dev/null
for _ in $(seq 1 60); do rpc "$RPC_PORT" eth_chainId | grep -q result && break; sleep 0.5; done
rpc "$RPC_PORT" eth_chainId | grep -q result || { echo "ethrex did not start" >&2; docker logs --tail 30 vajra-ethrex >&2; exit 1; }

# --- blocks ---
JWT_FILE="$work/jwt.hex" ENGINE_URL="http://127.0.0.1:$ENGINE_PORT" RPC_URL="http://127.0.0.1:$RPC_PORT" \
  nohup node "$here/miner.mjs" > "$work/logs/miner.log" 2>&1 &
echo $! > "$work/miner.pid"

# --- the sidecar ---
data="$work/sidecar-data"
rm -rf "$data" && mkdir -p "$data"
cat > "$data/config.json" <<JSON
{
  "entryPoints": ["$ENTRY_POINT"],
  "canonicalEntryPoint": "$ENTRY_POINT",
  "standardMempoolId": "$MEMPOOL_ID",
  "supportedMempools": [{ "mempoolId": "$MEMPOOL_ID", "entryPoint": "$ENTRY_POINT" }],
  "relayers": ["$GENESIS_KEY"],
  "rpcEndpoint": "http://127.0.0.1:$RPC_PORT",
  "rpcEndpointSubmit": "http://127.0.0.1:$RPC_PORT",
  "stakingRegistryAddress": "$REGISTRY",
  "bundleInterval": 2
}
JSON
(cd "$work/sidecar" && SKANDHA_FAUCET_KEY="$GENESIS_KEY" NODE_ENV=production nohup bun --bun packages/cli/bin/skandha.js standalone \
  --configFile "$data/config.json" --dataDir "$data" \
  --api.address 127.0.0.1 --api.port "$SIDECAR_PORT" --api.wsPort "$SIDECAR_PORT" \
  --executor.bundlingMode auto --redirectRpc --explorer.enable \
  > "$work/logs/sidecar.log" 2>&1 & echo $! > "$work/sidecar.pid")
for _ in $(seq 1 60); do rpc "$SIDECAR_PORT/rpc/" eth_chainId | grep -q result && break; sleep 0.5; done
rpc "$SIDECAR_PORT/rpc/" eth_chainId | grep -q result || { echo "the sidecar did not start" >&2; tail -30 "$work/logs/sidecar.log" >&2; exit 1; }
echo "mirror up: ethrex http://127.0.0.1:$RPC_PORT, alt mempool http://127.0.0.1:$SIDECAR_PORT/rpc/"
