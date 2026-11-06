# The sidecar commit the public devnet runs. ethrex is pinned by image in docker-compose.yml.
SIDECAR_COMMIT=2e22ff0
SIDECAR_REPO=https://github.com/forshtat/mempool-workshop-sidecar
# Published with the upstream devnet as a throwaway key, and funded in genesis.json. It deploys, and on the mirror only.
GENESIS_KEY=0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15
# Several mirrors can run side by side: VAJRA_LANE=1 moves every port up by 100 and gives Compose its own project.
lane="${VAJRA_LANE:-0}"
export VAJRA_RPC_PORT=$((18545 + lane * 100)) VAJRA_SIDECAR_PORT=$((14337 + lane * 100)) VAJRA_UNPATCHED_PORT=$((14338 + lane * 100)) VAJRA_EXPLORER_PORT=$((18080 + lane * 100))
[ "$lane" = 0 ] || export COMPOSE_PROJECT_NAME="vajra$lane"
