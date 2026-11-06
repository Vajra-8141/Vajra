# Reproducing the sidecar findings

Needs Docker, Node 22.18 or newer, and pnpm. About five minutes.

    git clone https://github.com/Vajra-8141/Vajra.git && cd Vajra
    make judge          # ethrex 9aa3645 by image, sidecar 2e22ff0 + the patch, whole suite deployed
    make unpatched      # the same sidecar with no patch, on port 14338
    alias vajra='VAJRA_STACK=local node packages/cli/src/main.ts'
    vajra compare       # one proof transaction, byte for byte, offered to both, and to the canonical mempool

Expect:

    sidecar as deployed:  validation prefix execution gas sum 500000 + signature-verification cost 0 = 500000 exceeds MAX_VERIFY_GAS 100000
    canonical mempool:    Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS
    sidecar with the patch: mined, VERIFY 298,084 gas

The sender holds a stake of 0.012 ETH. The frame runs a Groth16 pairing check through precompiles `0x06` to `0x08`.

The patch is [`sidecar-budget-010.patch`](sidecar-budget-010.patch), and [`README.md`](README.md) says what it changes. It implements BUDGET-010 and CALLING-040 as
ERC-8421 states them, with the draft's 100,000 and 1,000,000. The state-gas cap is left alone.

Two things in here may be useful on their own:

- `stack/miner.mjs` mines Hegota from genesis with no consensus client, by driving FCUv5, getPayloadV6 and newPayloadV6.
- `docs/FINDINGS.md` section 8: approving a transaction spends every nonce key it names, including when its SENDER frame then fails. Any account
  with more than one authorization path has to constrain which nonce keys each may touch.
