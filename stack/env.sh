# Pinned versions of everything the local mirror runs. The public devnet runs these same two commits.
ETHREX_COMMIT=9aa3645d795945c64400f41a70aace0edfa7f383
ETHREX_IMAGE="ghcr.io/forshtat/ethrex:eip8141-tracer-$ETHREX_COMMIT"
SIDECAR_COMMIT=2e22ff0
SIDECAR_REPO=https://github.com/forshtat/mempool-workshop-sidecar
RPC_PORT=18545
ENGINE_PORT=18551
SIDECAR_PORT=14337
P2P_PORT=30343
# Published with the upstream devnet as a throwaway key, and funded in stack/genesis.json. It relays and it deploys.
GENESIS_KEY=0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15
REGISTRY=0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f
ENTRY_POINT=0x00000000000000000000000000000000000000aa
MEMPOOL_ID=QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk
