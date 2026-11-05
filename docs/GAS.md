# Measured gas

Measured on the live devnet on 2026-11-05 with `ethrex_simulateFrameTransaction`, which runs the real client against
live state and reports per-frame gas whether or not a limit is over the mempool's cap. 24 fresh digests per row, each a
real signature verified by the deployed account. Reproduce with `node packages/cli/src/main.ts measure`.

| Winternitz parameter | Signature | Hashes to verify | VERIFY gas (min / median / max) | Whole tx (median) | vs the 100,000 cap | Live alt mempool |
|---|---|---|---|---|---|---|
| **w=16** (67 chains) | 2,144 B | 435 to 570 | 85,482 / **90,009** / 93,519 | 167,418 | fits | **admitted and mined** |
| w=256 (35 chains) | 1,120 B | 4,080 to 5,610 | 289,677 / **334,362** / 378,879 | 383,090 | 3.3x over | refused |

Fitted cost: `59,289 + 60.2 x hashes` for w=16 and `51,834 + 58.3 x hashes` for w=256. The fit matters because a signature
cannot be tried against a node first: that would reveal the one-time key. The client reads the hash count off the digest
before anything is signed, and draws a new digest if it would not fit.

w=4 (133 chains, 4,256 B) was measured in Foundry only, at 46,317 gas for the verifier alone. Its extra signature bytes
cost more than its fewer hashes save, so it was not deployed.

## Where the w=16 gas goes

From the fit above and the client's constants, not from a per-opcode trace:

| Part | Gas | Source |
|---|---|---|
| Hash chain steps | 26,000 to 34,000 | fit: 60.2 per hash, 435 to 570 hashes |
| First use of a keyed nonce, charged inside VERIFY | 20,000 | `KEYED_NONCE_FIRST_USE_GAS` |
| Everything else: frame opcodes through helper contracts, clone delegatecall, storage reads, Merkle path, leaf hash | about 39,000 | the fit's fixed term, less the 20,000 |

Keyed-nonce first use is the largest single fixed cost, and a one-time key pays it every time. Using one nonce key with the
leaf as its sequence would save it, at the cost of being unable to skip a leaf that was revealed but never mined.

## Other paths

| Path | VERIFY gas |
|---|---|
| Daily key, signed by the client (protocol ECDSA) | 30,759 |
| Daily key, signed by a stock wallet with personal_sign | 42,318 |

## The third w=256 checksum chain

The spec has 3 checksum chains at w=256. The largest possible checksum is 32 x 255 = 8,160, which fits in 2 digits, so the
third digit is always zero and that chain carries nothing. It costs 255 hashes (about 15,000 gas) and 32 bytes. Dropping
it is a one-constant change: `len2` is a constructor argument of `VajraAccount`.
