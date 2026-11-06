# What the live devnet actually does

> The public devnet was reset on 2026-11-06. Transaction hashes in sections 1 to 6 are from the chain before that, and can no longer be looked up. `vajra pin` has been rerun on the new chain.

Everything here was observed on the public devnet (chain 1337) on 2026-11-05, or read in the source it runs:
`forshtat/mempool-workshop-sidecar` at `2e22ff0`, `forshtat/ethrex` branch `eip8141-tracer` at `9aa3645`.

## 1. The alt mempool caps validation at 100,000 gas, staked or not

ERC-8421 BUDGET-010 gives a staked entity 1,000,000 (the landing page says 2,500,000). The deployed sidecar has no such
budget. `validateStructuralRules` applies one flat cap to the whole prefix, before stake is ever looked up:

    packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts:288
    if (totalVerifyGas > MAX_VERIFY_GAS) { ...

Observed on both the miner and the gateway, from a sender with a confirmed stake of 0.012 ETH (minStake is 0.01):

    VERIFY limit 400000: validation prefix execution gas sum 400000 + signature-verification cost 2800 = 402800 exceeds MAX_VERIFY_GAS 100000
    VERIFY limit 900000: validation prefix execution gas sum 900000 + signature-verification cost 2800 = 902800 exceeds MAX_VERIFY_GAS 100000

Reproduce: `node packages/cli/src/main.ts budget`. The sender is `0xe5d1aB06F0E400F62a4c421c4089E25ddb0aBBFd`, staked in
`0x6ca716c391b55ab5018e168f80a09b62b0bc0d06c4d490a1d2113b2e6f5304c9`.

**Consequence:** the first example in the track's own brief, a PQ wallet needing more than 100k of verification, cannot
currently be admitted through the sidecar by anyone. This looks like a feature the sidecar has not implemented yet rather
than a protocol limit: ethrex's source treats `max_verify_gas` as mempool policy, and `ethrex_simulateFrameTransaction`
runs a 378,879-gas VERIFY frame to success. A VERIFY frame that large has not been tested in a mined block.

**Update:** the patch now compiles and runs. A staked 400,000 VERIFY limit is admitted, and a 298,084-gas VERIFY frame mined. See section 7.

## 2. Every precompile is refused during validation

CALLING-040 allows precompiles `0x01` to `0x11`. The live node has `precompiles: []`, and the check at
`validators/frameTx.ts:816` treats anything not in that list as undeployed:

    payer accesses un-deployed contract address 0x0000000000000000000000000000000000000001 with opcode STATICCALL

This blocks `ecrecover` in validation, a SHA-256 hash variant, and the pairing precompiles any Groth16 verifier needs, so
it also blocks the planned v1 of STARK recovery and shielded spends. It is a config value: `SKANDHA_PRECOMPILES`.

## 3. A thief holding the daily key can block the escape on the canonical mempool

The canonical mempool refuses a keyed transaction while a linear one from the same sender is pending. The alt mempool
keeps the two domains independent. With a thief's valid daily-key transaction pending, the same signed escape got:

    canonical: A frame transaction in the other nonce-key domain is already pending for this sender
    alt:       admitted and mined, all frames succeeded

Run three times, all mined, the last on the current deployment: `0x40bd1052ce52bfa7e7f9ae2fb990907b4f6f1e70f6893065ebc189ff1d4a980f`,
`0xf3c7e7b6fde6c2d34dfe0c457cffa5fd0a4753329b15d40e42380ef37bea06a8`,
`0x0c858f5d37628812d70fc46ae1cf8ec36132492dd1e786134d68eb09c18495f2`. Reproduce: `node packages/cli/src/main.ts pin`.

What this does and does not show. It holds for as long as a thief's transaction is pending. On this idle devnet that is
one slot, so holding the block open means sending a new transaction every slot, paid for by the victim's account and
bounded by its balance. With no pending transaction, the canonical mempool admits the same w=16 escape.

## 4. Smaller things that cost time

- **A CALL paying a new address needs 183,600 spare execution gas in a frame.** `opcode_handlers/system.rs:153` computes
  a state-gas spill against `state_gas_reservoir`, which is always 0 in a frame, and subtracts it from execution gas even
  though the state gas is charged to the frame's own pool. The gas is not spent, only required. With too little, the frame
  dies with out of gas while reporting no state use.
- **Admitted does not mean mined.** About 5% of recent transactions end `relayed 4 times without being included in a
  block`. Rebroadcasting the identical bytes works, and it is the only safe retry for a one-time key.
- **The gateway does not reliably reach the miner.** A transaction sat in the gateway's mempool while the miner never saw
  it. VAJRA submits to the miner's sidecar directly.
- **An ECDSA entry with an explicit `msg` keeps its bytes in the signature hash**, so that hash cannot be what `msg` commits
  to. A wallet path has to rebuild its digest from the transaction's fields instead.
- **Keyed-nonce first use costs 20,000 gas inside the VERIFY frame.**
- **State gas is 1,530 per byte of code**, so a 10 KB contract costs about 18.7M to deploy, over the 16.7M regular cap but
  allowed, since state gas sits outside it.
- **Cold account access is 3,000 on this fork**, not 2,600.
- **The faucet was empty** at 23:00 IST on 2026-11-05, having worked an hour earlier.
- **anon-rpc routes differ in a browser.** The Nym worker was ready in 16 seconds and served real lookups, so it is the
  dashboard's default. The Tor worker's demonstration gateway had not come up after 75 seconds.
- **The Nym worker cannot reach the sidecar.** Over Nym, `/rpc` answers `HTTP 415`, the same as a request with no usable
  content type (`application/json` and `text/plain` pass; a missing header and `application/octet-stream` do not). The same
  request passes over the passthrough worker, and ethrex accepts it over Nym. The harness hands the worker headers as a list
  of pairs, as the spec says, and the worker gives that list to `mixFetch`; where exactly the header is lost was not traced
  further. So reads use the mixnet and transactions go direct, and the dashboard says so before anything is signed.
- **A stealth spend is also valid on the canonical mempool**, per `ethrex_simulateFrameTransaction`, even with a
  non-canonical paymaster. So stealth does not depend on the alt mempool, and finding 3 does not apply to it: a stealth
  account has no daily key for a thief to race with.

## 5. Where the specs had to change

| Spec | What it says | What is true |
|---|---|---|
| 04 §1, 03 §1 | Master-key operations exceed the budget, so only the alt mempool routes them | True of w=256, which no mempool admits today. True of neither at w=16, which fits the cap. The alt mempool is still required, for finding 3 |
| 03 §4, refusal 1 | Public mempool refuses, alt mempool admits, on gas | Both refuse over 100k today. The refusal that works live is finding 3 |
| 04 §4 | Each rule is one validation check | TIMESTAMP is banned in every mempool and VERIFY is static, so the rulebook runs in the SENDER frame. VERIFY enforces who may act and the shape of the transaction |
| 04 §3 | Nonce key = leaf index | Derived from root and leaf, or a rotated tree would collide with the keys the old tree used |
| 04 §5 | 3 checksum chains at w=256 | 2 are enough: see GAS.md |
| 03 §9 | No faucet, gateway is `altmempool.forshtat.com` | A faucet exists when funded; `altmempoolgateway.forshtat.com` also exists, and the miner's sidecar is the reliable one |

## 6. Two traps the specs do not mention, both closed

- `sender_approved` covers every SENDER frame, so a daily key could append `token.transfer(thief, everything)` and never
  touch the rulebook. `validateDaily` walks every frame.
- The protocol checks an ECDSA signature against whatever `msg` holds, so without a check, any signature the daily key
  ever produced would authorize a transaction. `validateDaily` requires `msg` to be empty or the rebuilt digest.

## 7. The local mirror: what ran, and what it showed

Everything here ran locally, on 2026-11-06: ethrex `9aa3645`, by its published image, and the sidecar `2e22ff0` with
`docs/upstream/sidecar-budget-010.patch`.

- **The patch compiles and passes.** It builds as part of the sidecar, and the sidecar's own validation and explorer suites pass, 146 of 146.
- **A VERIFY frame over 100,000 mines.** 298,084 gas, a Groth16 pairing check through precompiles `0x06` to `0x08`, in a mined block. Finding
  1 said that had not been tested.
- **The same bytes, on two sidecars.** The sidecar as deployed refuses, and the patched one mines. `docs/evidence/compare-latest.json`.
- **Hegota at genesis needs no consensus client.** A real one refuses that genesis, and ethrex's `--dev` producer still calls FCUv4, which refuses
  Hegota attributes. A hundred lines driving FCUv5, getPayloadV6 and newPayloadV6 mine from block 1, in one container, in seconds. `stack/miner.mjs`.
- **The frozen flows reproduce on the mirror, unmodified.** `vajra e2e`: 11 mined, 21 refused, 0 failures, as on the public devnet. `vajra pin`: the
  canonical mempool refuses and the alt mempool mines.
- **`SELFBALANCE` in validation needs a stake strictly above the minimum.** `frameTx.ts` compares with `>`, so a stake of exactly 0.01 does not pass.
- **A precompile that fails burns all the gas it is forwarded.** A proof with a point off the curve spends 63/64 of what is left. The named
  refusal still comes back at a 500,000 limit, but it would not at a much lower one.
- **`bundleInterval` is in milliseconds.** A value of 2 starves the reconciler: mined transactions stay `Submitted`, keep counting against the
  sender's balance, and new ones get refused with `cannot cover its pending frame transactions`.
- **The node's mempool cap is a separate check from the sidecar's.** ethrex refuses a prefix over 100,000 at `eth_sendRawTransaction`, whatever the
  sidecar's budget, and a sidecar patch does not change that. The patched sidecar's own submission path goes around it.

## 8. A thief with the daily key could end the master key

Found by an independent review of `VajraAccountV2`, then reproduced. **Fixed on chain:** the devnet was reset on 2026-11-06, and the suite deployed since has this fix. Below, "deployed" means the
contract first deployed, which no longer exists.

`validateDaily` checks who signed and which functions the frames reach. It never looks at the transaction's nonce keys. Approving a transaction
spends every nonce key it names, and the master key's keys are public: `keccak(root, leaf)`. So a thief signs ordinary daily no-ops on those keys,
three to a transaction under the 100,000 cap. Each key's nonce moves to 1. `validateMaster` needs 0, so that leaf can never sign again.

Against the deployed source, on the mirror, with only the daily key (`vajra nonce-burn`, `docs/evidence/nonce-burn-deployed-contract-latest.json`):

    64 of 64 leaves burned, in about 90 seconds, for about 0.003 ETH of the victim's own balance
    the owner's escape: Nonce mismatch: expected 1, got 0

That includes the rotation leaf, so the tree cannot be replaced. No veto, no freeze, no escape, no new daily key, for good. A queued spend then cannot
be cancelled, so the thief takes everything after one queue delay. This is worse than finding 3, which lasts only while a transaction is pending.

**It was not run on the public devnet.** The mirror runs the same source and the same client, and the deployed sidecar's limits are no looser for a
daily transaction, but that is reasoning, not a measurement. Accounts on chain 1337 should be taken to be exposed.

**The fix is one check,** now in `VajraAccount.sol` and `VajraAccountV2`: the daily key stays on the linear nonce, or `DailyNonceKeyInvalid`. Same attack: 0 of 64,
and the escape is admitted (`docs/evidence/nonce-burn-fixed-contract-latest.json`, `nonce-burn-v2-latest.json`). `vajra e2e` now attempts it too.

**It is on the public devnet.** The reset took the old contracts with it, so `stack/redeploy-public.sh` deployed the whole suite with the fix, for about 0.04 ETH. `vajra e2e` on the new chain attempts this attack and gets
`DailyNonceKeyInvalid`. The bytes first deployed are kept in `packages/core/src/artifacts/VajraAccount.pre-fix.json`, so that `vajra nonce-burn` still reproduces it, on the mirror.

The same review found a bug of the same family in the first version of V2, also reproduced live, and fixed. A proof transaction has no signature, so anyone
could copy a pending one and cut its SENDER frame's gas. The proof passes, the nonce is spent, the frame fails, and the transaction is mined. The
nullifier is untouched but its nonce key is gone, so a recovery or a note is dead for good, for the cost of nothing. VERIFY now pins that gas exactly.

**The lesson:** in EIP-8141, approving a transaction spends its nonce keys, and a mined transaction whose SENDER frame failed still spent them. An account
has to decide which nonce keys each path may touch, and everything that consumes a nonce has to be pinned by whatever authorizes it.

## 9. Whoever paid a stealth account could take the money back

Found by a second independent review, then reproduced on the real client. **Fixed in what is deployed since the reset.**

A stealth account's hash key is derived from a secret the payer knows, which is why spending also needs a co-signature the payer cannot make. `validateMaster` asked for that
co-signature only when the nonce key was 0. On a keyed nonce, the master key's ordinary path, it took the other branch and never looked. So the payer signs an ordinary master
transaction with the seed it already has.

On the mirror, against the bytes first deployed (`vajra stealth-theft`, `docs/evidence/stealth-theft-deployed-contract-latest.json`): the payer took 25 of 25 tokens, with no co-signature,
after sending the account a little ETH to pay for itself. The token on the mirror is a stand-in. **It was not run on the public devnet.**

`vajra stealth` said `CoSignerRequired`, and that was true of what it tried: it only ever tried nonce key 0. The claim was wider than the test, and that is how this survived. The attack is now
in `vajra stealth`, on both paths.

**The fix is one check:** an account with a co-signer refuses keyed nonces. Same attack: `CoSignerRequired`, 0 taken. It is in the source of both contracts, and goes out with the same redeploy as
section 8. `vajra stealth` has not yet been rerun on the new public chain: the fix is proven on the mirror.

### Also from that review

Both fixed, in `VajraAccount.sol` and `VajraAccountV2`, and deployed:

- **The daily key could make the account pay for a thief's own transaction.** `validateDaily` never checks that the transaction's sender is the account, and with `Scope.PAYMENT` it acts as a paymaster.
  Each is capped per transaction, and no nonce of the account's is touched. Traced in code, not reproduced live.
- **Anyone could cancel a stock wallet's pending spend.** The wallet digest leaves out the body frame's mode, and the frame walk skips anything that is not SENDER, so a copy can turn the spend into a no-op under
  the same signature. The nonce and fee are spent and nobody is paid. The owner can sign again. Shown with mocked frame opcodes, not reproduced live.

**Open in both,** as design limits, and in the README: fee burn across many transactions, and a queue with no cap that survives a change of daily key.
