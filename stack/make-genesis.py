#!/usr/bin/env python3
"""Regenerates stack/genesis.json. Run this only to change the mirror: the file is committed, and a judge never needs to.

Starts from ethrex's own Hegota genesis, then matches the public devnet: its gas limit, its base fee, the staking registry at
the same address with the same runtime, and a funded genesis key. The stand-in token goes where the devnet's USDC lives.
"""
import json, subprocess, sys, urllib.request

REGISTRY = "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f"
USDC = "0xefe0d421fd473564c9c9b0cdceb194cf476d6af5"
GENESIS_KEY_ADDRESS = "0x5544596212f91984c986a919c8026df0576816f9"
BALANCE = 10**15  # a billion, at six decimals


def public_code(address):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getCode", "params": [address, "latest"]}).encode()
    request = urllib.request.Request("https://altmempool.forshtat.com", data=body, headers={"content-type": "application/json", "user-agent": "vajra"})
    return json.load(urllib.request.urlopen(request, timeout=15))["result"]


def balance_slot(owner):
    key = owner[2:].rjust(64, "0") + "0" * 64
    return subprocess.check_output(["cast", "keccak", "0x" + key], text=True).strip()


fixture, token = sys.argv[1], sys.argv[2]
genesis = json.load(open(fixture))
genesis["config"]["chainId"] = 13370
genesis["timestamp"] = "1"
genesis["gasLimit"] = "0x3938700"
genesis["baseFeePerGas"] = "0x7"
genesis["alloc"][GENESIS_KEY_ADDRESS] = {"balance": hex(10**6 * 10**18)}
genesis["alloc"][REGISTRY] = {"balance": "0x0", "code": public_code(REGISTRY), "nonce": "0x1", "storage": {}}
genesis["alloc"][USDC] = {
    "balance": "0x0",
    "code": json.load(open(token))["deployedBytecode"]["object"],
    "nonce": "0x1",
    "storage": {balance_slot(GENESIS_KEY_ADDRESS): "0x" + hex(BALANCE)[2:].rjust(64, "0")},
}
json.dump(genesis, open(__file__.rsplit("/", 1)[0] + "/genesis.json", "w"), indent=0)
