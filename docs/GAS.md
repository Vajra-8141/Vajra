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
| Daily key on V2, signed by a stock wallet as typed data, on the mirror | 49,923 |
| The exit's VERIFY frame, on the mirror, with the digest under 430 hashes | about 97,000 |
| A rescue, which is that same frame, signed in advance, on the mirror. About 490,000 for the whole transaction, to a fresh harbor. At a 10 gwei cap the reserve has to hold about 0.0125 ETH | about 97,000 |

## The third w=256 checksum chain

The spec has 3 checksum chains at w=256. The largest possible checksum is 32 x 255 = 8,160, which fits in 2 digits, so the
third digit is always zero and that chain carries nothing. It costs 255 hashes (about 15,000 gas) and 32 bytes. Dropping
it is a one-constant change: `len2` is a constructor argument of `VajraAccount`.

## Proofs

Measured on the local mirror, 2026-11-06, the same way: `ethrex_simulateFrameTransaction`, a fresh proof per sample. Reproduce with `vajra measure-zk`.
Recorded in `docs/evidence/zk-gas-latest.json`. **These are mirror numbers, not public devnet ones:** same client, same commit, a different chain.

| Path | Samples | VERIFY gas (min / median / max) | Whole tx (median) | vs the 100,000 cap | vs the staked 1,000,000 | Sidecar as deployed |
|---|---|---|---|---|---|---|
| Recovery, Groth16, 8 public inputs | 24 | 298,084 / **298,084** / 298,084 | 876,901 | 3.0x over | fits | refused |
| Unshield, Groth16, 6 public inputs | 32, one per ring position | 286,226 / **321,330** / 354,240 | 661,927 | 2.9x to 3.5x over | fits | refused |

A recovery's cost does not move, because its path through the verifier is the same whatever the proof. An unshield's depends on where its root sits in the
ring: the check walks it, at about 2,200 gas a slot, which is the whole spread. The VERIFY limit declared is 500,000.

| Other | Gas |
|---|---|
| Shield, the first note, SENDER frame (twenty Poseidon hashes) | 896,305 |
| Shield, later notes, whole transaction (31 samples) | 965,798 / **986,904** / 1,008,017 |

A proof takes about 80 ms for recovery and about 340 ms for an unshield, on a 16-core x86-64 machine. Recovery has 937 constraints and the pool 11,336.

The note fee on the mirror is 0.005 ETH, out of a 0.1 ETH note. It is the cap on what a proof transaction may cost. At these limits that is about 3 gwei, so
honest proof transactions cannot be included above that. The fee is immutable, which is fine here and would not be on a network with a real fee market.

## leanSphincs-S: a hash key with no leaves to run out of

Measured on the local mirror, 2026-11-06, with `vajra sphincs-bench`, and recorded in `docs/evidence/leansphincs-gas-latest.json`. **These are mirror numbers, not public devnet ones, and no account relies on this key.** Each row is 24 fresh digests, each a real signature, through `ethrex_simulateFrameTransaction`.

leanSphincs-S is a parameter set from [nconsigny/SPHINCs-](https://github.com/nconsigny/SPHINCs-) at `4c76aaf`: one tree of height 26, FORS 13 x 12, WOTS+C with 64 chains, and 16-byte hashes over keccak256. The verifier is that repository's file, unchanged. The sender around it, `contracts/src/bench/LeanSphincsBench.sol`, is ours: a clone that keeps its key in storage, so that it pays what a clone of the account or the exit pays.

| Path | Key | Bytes in the signature entry | VERIFY gas (min / median / max) | Whole tx (median) | Fits the 100,000 cap |
|---|---|---|---|---|---|
| A payment, `validateMaster` on V2, new nonce key | hash key, w=16 | 2,337 | 86,992 / **90,799** / 93,175 | 173,162 | yes |
| A payment, the same steps, new nonce key | leanSphincs-S | 4,164 | 90,581 / **90,775** / 90,879 | 288,042 | yes |
| A payment, the same steps, a nonce key used before | leanSphincs-S | 4,164 | 70,654 / **70,722** / 70,820 | 288,042 | yes |
| A payment, the same steps, linear nonce | leanSphincs-S | 4,164 | 70,649 / **70,776** / 70,922 | 285,994 | yes |
| Veto, `VajraExit`, new nonce key | hash key, w=16 | 2,337 | 95,565 / **97,392** / 97,773 | 172,867 | yes |
| Veto, a sender of its own, new nonce key | leanSphincs-S | 4,164 | 101,402 / **101,554** / 101,680 | 284,346 | **no** |
| Veto, a sender of its own, linear nonce | leanSphincs-S | 4,164 | 81,476 / **81,544** / 81,676 | 282,298 | yes |
| Escape, `VajraExit`, new nonce key | hash key, w=16 | 2,337 | 94,666 / **97,441** / 97,837 | 490,229 | yes |
| Escape, a sender of its own, linear nonce | leanSphincs-S | 4,164 | 81,358 / **81,499** / 81,626 | 569,962 | yes |

"The same steps" means what `validateMaster` does, on a sender of its own. V2 has no such path, and adding one is a contract change. The veto and escape rows run against a real `VajraAccountV2`, which needed no change: `setExit` takes any address.

**It fits, if the sender keeps one nonce.** Every row on a kept nonce is under the 99,900 limit, with no stake. These were really sent and mined: the payment on a new nonce key through both mempools, the payment on a kept nonce key and the veto through the alt mempool, and the escape through the canonical mempool past a thief's pending transaction. The one row over the cap is a veto on a new nonce key, where the walk over the frames costs too much. Its limit was raised to 120,000 so that the number could be read, and the admission simulator says both mempools refuse that. That row was not sent.

**VERIFY costs about the same as the hash key's, and the transaction costs more.** Like for like, on a new nonce key, a payment costs the same and a veto 4% more. The linear rows look cheaper only because a stateless key can skip the 20,000 a new nonce key costs. The verifier itself takes about 40,000 gas in `forge test`, and the rest of VERIFY is the frame opcodes through helper contracts, the clone, and storage.

A byte in a transaction has a floor of 64 gas, so 4,164 bytes cost 266,496 gas whatever VERIFY does. So a veto costs 63% more and a payment 66% more. An escape costs 16% more, because both keys pay the same 281,520 of state gas for it.

**The gas does not depend on the digest.** A signature always takes 249 keccak calls, so these rows spread by under 300 gas, against 6,183 for the hash key's payment, and nothing has to be redrawn before signing.

| Signing, TypeScript on one thread, AMD Ryzen 7 6800H | leanSphincs-S, Light tier | Hash key, w=16 |
|---|---|---|
| Generating a key | 1,851,418 keccak calls, 21 s | 1.3 s |
| A signature | about 158,000 keccak calls, median 1.6 s, worst 3.4 s, 181 samples | median 12 ms, 48 samples |
| What the signer keeps | the seed and a 16 KiB cache | the seed and a record of every leaf revealed |
| How many signatures | rated 20,000 by upstream, an estimate, and nothing counts them | 63, then rotate |

Upstream reports 7 to 29 ms a signature from its Rust signer on 8 cores. **We did not run that signer**, so that number stays upstream's. Ours was written from the spec and matches upstream's six known-answer vectors byte for byte. The Standard and Full tiers were not run: they change the work and the lifetime, and not the signature or the gas.

**It has not run on the ESP32, and the firmware has no such signer.** The board's recorded boot derives a tree, which is 68,735 keccak calls in 10 seconds, about 6,900 a second. At that rate a signature would take about 23 seconds and generating a key about 4.5 minutes. That is arithmetic, not a run.

| On chain | Gas to deploy | Code |
|---|---|---|
| The verifier, shared by every sender | 6,189,395 | 3,872 B |
| The sender's implementation | 5,788,126 | 2,541 B |
| `VajraExitFactory`, for it | 1,610,617 | 906 B |

**What is left is a lifetime.** Upstream's estimate of security after N signatures on the Light tier: 135.9 bits at 20,000, 127 at 43,715, 116 at 100,000, with a ceiling of 128 from the 16-byte hash. It wears down with use, and there is no cliff. `coverBits` in `packages/core/src/leansphincs.ts` reproduces upstream's 43,715. **This is an estimate, and it has not been proved for these parameters.**
