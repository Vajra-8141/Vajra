# What the live devnet actually does

> The public devnet was reset on 2026-11-06. Transaction hashes in sections 1 to 6 are from the chain before that, and can no longer be looked up. `vajra e2e`, `pin` and `stealth` have been rerun on the new chain.

Everything here was observed on the public devnet (chain 1337) on 2026-11-05, or read in the source it runs:
`forshtat/mempool-workshop-sidecar` at `2e22ff0`, `forshtat/ethrex` branch `eip8141-tracer` at `9aa3645`.

## 1. The alt mempool caps validation at 100,000 gas, staked or not

> Since fixed on the public alt mempool: VERIFY up to 10,000,000 was admitted on 6 November. The canonical mempool still refuses over 100,000.

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

> Since fixed on the public alt mempool: a Groth16 proof through `0x06` to `0x08` mined there on 6 November, in `docs/evidence/recovery-public-latest.json`.

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

## 7b. A failed SENDER frame does not stop the next one

Unless they are an atomic batch. A release is a veto then a payment, and if the veto fails because the item was executed first, the payment would still run and pay twice. With the batch flag on the first frame, both undo: `vajra pay-e2e` races it on the mirror. The flag is bit 2 of `flags`, and it is invalid on the last frame.

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
section 8. `vajra stealth` on the new public chain attempts it, and gets `CoSignerRequired`.

### Also from that review

Both fixed, in `VajraAccount.sol` and `VajraAccountV2`, and deployed:

- **The daily key could make the account pay for a thief's own transaction.** `validateDaily` never checks that the transaction's sender is the account, and with `Scope.PAYMENT` it acts as a paymaster.
  Each is capped per transaction, and no nonce of the account's is touched. Traced in code, not reproduced live.
- **Anyone could cancel a stock wallet's pending spend.** The wallet digest leaves out the body frame's mode, and the frame walk skips anything that is not SENDER, so a copy can turn the spend into a no-op under
  the same signature. The nonce and fee are spent and nobody is paid. The owner can sign again. Shown with mocked frame opcodes, not reproduced live.

**Open in both,** as design limits, and in the README: fee burn across many transactions, and a queue with no cap that survives a change of daily key.

## Paymasters on the mirror

Two staked paymasters, in `contracts/src/paymasters/`: a daily gas quota for enrolled accounts, and one that takes USDC for gas. Everything here ran on the mirror, and nothing here is on the public devnet. `vajra paymaster-e2e` sends every attack, and `docs/evidence/paymaster-latest.json` has the run.

**The first version could be drained, with every test passing.** `vajra paymaster-e2e` had just reported 42 attacks refused and 0 failures when an independent review read the client and found this. An atomic batch that unrolls undoes a frame's effects and keeps its status. So an EOA paying for itself sent `[self_verify, collect (batched), a frame that reverts, settle]`: the collect was undone, its status still said success, and `settle` refunded USDC that was never taken. On the mirror it took 30,495,599 units, 30.5 USDC, from the float, and the attacker set the size with `max_fee`. The same shape reset a quota to zero. Our attack list had no batch in it. The claim was wider than the test, which is how section 9 happened too.

**The fix is two checks.** A charge frame insists the next frame is this contract's `pay`. A batch flag cannot be followed by a VERIFY frame, so such a charge is not in a batch that can undo it, and since one `pay` can approve, a valid transaction holds one charge at most. And `settle` requires that `pay` ran. The same attack now moves nothing, and is in the run. So is a stolen daily key adding collect frames to burn the approval, which the review found by the same route: each one now fails, and the account is charged once.

**Take the money first, and there is no repay frame to starve.** A paymaster that repays itself after the body has to survive the body: it can be starved of gas, or the body can revoke the approval. So the shape here is `[only_verify, charge, pay, SENDER..., settle]`. `charge` is a `pre_verify` frame, the one place before payment that can write. It takes the transaction's maximum cost, and `pay` refuses unless it succeeded. A failed frame does not fail a transaction, so that check is the defence. `settle` only ever gives back, so starving it costs the sender and not the paymaster.

**A refund has to be worked out from below.** The payer owes `mandatory + max(data + E, floor) + S`. Refunding "the unused gas" is wrong by the calldata floor: 8 KB of ignored bytes makes a transaction cost far more than its frames used. `settle` takes 64 gas per byte carried off the refund, and counts its own limit as used, which covers the bytes it cannot see. Limits and gas used are summed apart, because a frame that fails for want of state gas reports more than its limit. `testFuzz_what_stays_charged_covers_the_real_gas` holds this against ethrex's arithmetic, and it fails at once if the floor term is taken out. Every sponsored transaction in the run checks it again against a real receipt.

**The quota is counted at the maximum, in order.** Two transactions on different nonce keys can both pass admission on the same remaining quota. Only what runs first lands: `pay` reads the total after `charge` has added to it, so the second fails at inclusion, and nobody pays for it.

**`TIMESTAMP` is banned in validation, so a paymaster cannot know what day it is.** It keeps `day` in storage, moved by `settle` or by anyone calling `roll`. Each value of `day` gets one quota. If nobody has moved it, an account keeps spending what was left of yesterday's, and a whole quota follows once it moves. So around a boundary, late or not, an account can use a quota on each side and no more.

**ethrex's prefix simulator shapes where the checks go.** It keeps no frame results, so `FRAMEPARAM STATUS` halts there, with no data, and a passing transaction reports a failed frame. And it stops at the first failed frame, so `pay` never runs after a failed `charge`. So `charge` names its own refusals and `pay` reads the status last. On chain the status read still decides. A transaction with too little gas to reach those checks is refused by the node's own out-of-gas text, with no name of ours.

**The canonical mempool refuses all of it, every time.** On V1, with the prefix under 100,000, the reason is `StorageReadNonSender`, so it is the read and not the size. On V2 `validateDaily` takes 41,390 gas on the sponsored shape, so the quota prefix is over 100,000 and the budget refusal comes first. A master transaction's prefix is over the cap, and the USDC shape always is, so those get the budget refusal first.

**A keyed nonce costs the approving frame 20,000.** A pay frame that fits a linear nonce runs out of gas on a keyed one, and the simulator shows it as a bare revert.

### What the account cannot do

We left `VajraAccount` alone, so these stand on V1. V2 closes the third: see section 19.

- **The daily key cannot approve a token.** `validateDaily` only allows `spend` and `executeQueued` on the account. So the master key signs the approval. An account with no ETH can have the quota paymaster pay for that.
- **A stock wallet cannot use a paymaster.** The wallet digest is pinned to `[VERIFY, SENDER]`, so a sponsored transaction needs the daily key in a process that can sign the signature hash.
- **The rulebook does not see USDC paid for gas.** `validateDaily` skips DEFAULT frames, and the fee cap only applies when the account pays. So a stolen daily key can spend the account's USDC on gas, outside the daily limit, one maximum cost per transaction, up to the approval. With a colluding block producer, the tip part of that reaches the thief, up to `feeCap`. **Keep the approval small**: it is the only bound. A thief can also use up the day's quota. The real fix is in the account: apply the cost cap at every scope, and allow only the exact sponsored shape.

### Limits

- The USDC price is a number the owner sets, and the contract says so. Below the market, the paymaster loses the difference, up to `feeCap`.
- The sender signs the exact price, so a price change kills pending transactions. That protects them.
- `settle`'s own 100,000 limit is charged in full, and the floor term overcharges a little. Measured: 83,000 gas over the real cost on a plain spend, and 156,000 with 8 KB of data.
- A batch flag on the last body frame makes `settle` its terminator, so a body failure skips the refund. Only the sender loses, and only by signing that shape.
- That review was one read of the source, and it found a critical bug. **The fix has had no second independent review**: one was started and stopped before it reached a conclusion. Nothing here has been audited.
- `SponsorPaymaster`, which `vajra stealth` uses, is unchanged and can still be drained by anyone.
- An enrolled account can get transactions admitted that then fail at inclusion, which may count against the paymaster with the sidecar. Not measured.

## 10. A thief could get the account banned on a node

Suspected by a review of the sidecar, then reproduced. **Real.** It needs only the daily key, and it takes seconds.

The sidecar counts every admission as seen against the payer, a replacement included, and bans an address when `floor(seen / 10) > included + 50`. Our transactions pay for themselves, so that is the account. Ten percent of a fee under ten wei rounds down to nothing, so a thief can replace one transaction at the same fee with no limit at all. Even with a real bump, the ladder from 9 wei to the daily cost cap is 210 rungs, and a mined nonce starts a new one.

On the mirror, with only the daily key (`vajra rep-burn`, `docs/evidence/rep-burn-attack-latest.json`):

    550 admissions in 8.1 seconds, 3 of them mined, 5,595,605 wei of fees: seen 552, included 2, banned
    veto:     payer ... is banned
    escape:   payer ... is banned
    recovery: entity ... declares 500000 validation gas, which exceeds MAX_VERIFY_GAS_PER_ENTITY 100000

The recovery's refusal is the same ban by another door: a banned entity stops counting as staked, so it drops to the unstaked budget.

The canonical mempool keeps no reputation, so a banned escape could go there, and finding 3 is why that is not enough. With a thief transaction pending, it says `A frame transaction in the other nonce-key domain is already pending`. So a ban plus one pending transaction shuts both doors. A recovery has no second door at all: it is over the canonical cap.

**How long it lasts.** A ban is one node's opinion, and it decays hourly: 510 seen falls under the line after an hour, and about twenty admissions put it back. That is from the code, not a run. On a network of one miner's sidecar, that node is the network.

**What does not fix it:**

- **A separate payer.** Tried: the account as sender, a paymaster paying. `sender ... is banned`. Reputation counts the sender as well, so the ban follows the address, whoever pays.
- **A daily path limit.** Reasoned through, not built. VERIFY cannot write, and an unmined replacement never reaches a SENDER frame, so the contract cannot count admissions. All it could do is narrow the fee window, so that each nonce has fewer rungs. Then the thief needs more nonces, and those are paid for by the victim. That slows the ban without stopping it, and every pending daily transaction would have to escrow most of the cost cap, which makes section 11 worse.

**What fixes it, on our side:** a sender the thief cannot sign for. See section 12. Same attack, same ban, and from the exit: veto, recovery and escape all admitted and mined, with the account banned and a thief transaction pending (`vajra rep-burn fixed`, `docs/evidence/rep-burn-fixed-latest.json`).

**The sidecar rule we propose,** in [`upstream/sidecar-reputation.patch`](upstream/sidecar-reputation.patch), separate from the budget patch:

1. Replacing a live entry does not count as seen. Only one of the two can ever be included, so the second is no new evidence about the sender.
2. A bump is compared without dividing, so a fee cannot be raised to itself.

It applies on the mirror only by asking: `VAJRA_SIDECAR_RULE=1 make judge`, then `vajra rep-burn rule`. Same attack: 210 replacements, stopped by `DailyTxCostExceeded` at the top of the ladder, seen stays at 3, and veto, recovery, a paymaster's freeze and the escape are all admitted (`docs/evidence/rep-burn-sidecar-rule-latest.json`). The sidecar's own tests for the code it touches pass, 74 of 74.

**What the rule leaves.** A thief can still earn seen without included, by getting a transaction admitted and then mining another on that nonce through the canonical mempool. That is one per block, at the victim's expense, so about 510 blocks instead of 8 seconds. We have not run this.

## 11. A thief could make an escape something the mempool will not hold

Suspected by the same review, then reproduced. **Real, for an account short of ETH.** It is narrower than it first looked, and it has one more way in than was suspected.

The sidecar adds up what pending transactions could take from an account, across nonce domains, and refuses anything that does not fit in the balance. What counts is the maximum cost, not what will be paid. Daily transactions are on the linear nonce and the sidecar refuses a nonce gap, so **a thief can hold only one pending at a time**, up to the daily cost cap. So this takes an account whose ETH is under about the cap plus an escape's 0.0025 ETH. Value in tokens does not help, because tokens do not pay for gas, and the thief can spend ETH down to that line inside the daily limit.

On the mirror, with 25 tokens in the account (`vajra escape-solvency`, `docs/evidence/escape-solvency-attack-latest.json`):

    pending thief transaction at 0.009 ETH of cost, 0.0100 ETH in the account
    escape:  ... cannot cover its pending frame transactions: they would owe 11634156570333100 wei

A mined transaction goes on counting until the reconciler sees it, so the refusal outlasts the block.

An escape already admitted is not safe either. Sent straight to the node, a thief's spend never appears in the sidecar's sums, and when it lands the escape is cancelled:

    Cancelled: ... can no longer cover its pending frame transactions as of block 416

That one is a race. On the mirror the escape won when offered 0.3 and 0.6 seconds into the slot, and lost at 0.9 and 1.2, and at 1.0 it has gone both ways, so `vajra escape-solvency` can come out either way here. Once the ETH is gone, the escape cannot pay for itself at all, and the tokens stay. That is the top-up race in the README, seen from the escape's side.

**The fix is the same second sender.** The exit pays from its own reserve, so its escape owes nothing against the account's balance. Same attack, then the exit: mined, 25 of 25 tokens in the harbor (`vajra escape-solvency fixed`, `docs/evidence/escape-solvency-fixed-latest.json`).

## 12. Why there are two ways out

A judge will ask: why not a separate sender? **We now have both.** Our rival QueueBit uses a separate sender contract. So does `contracts/src/VajraExit.sol`, and the hash key stays in validation: `validateExit` verifies the Winternitz signature in the VERIFY frame.

Everything that can stop an escape from the account is attached to the account's address. A pending thief transaction holds that sender on the canonical mempool. Reputation is counted per address. Solvency is counted against that address's balance. The daily key can spend all three. The exit is a different address with its own money, and only a Winternitz signature can approve a transaction from it, so the daily key reaches none of them.

| | From the account | From the exit |
|---|---|---|
| Needs setting up | no | yes: one contract, one master transaction, a reserve |
| Who can use it | the master key, for anything | the exit tree, for `veto`, `freeze` and `escape` only |
| A thief's pending transaction | blocks it on the canonical mempool. **This is why it needs the alt mempool** | does not reach it, on either mempool |
| A ban on the account | blocks it | does not reach it |
| The account short of ETH | blocks it | does not reach it |
| Pays with | the account's balance | its own reserve |
| VERIFY gas, measured | about 93,000 | about 97,000, at most 430 hashes |
| One-time key safety | the Arkiv registry, the signer's record, the nonce key | the signer's record and the nonce key. **Not in the Arkiv registry** |
| Hardware signer | yes | **no**: software only today |
| Recovery by proof | yes, until the account is banned | yes, with a stake, on the alt mempool only: the pairing is over the canonical cap |

`vajra pin` still shows the blocked exit on the account, unchanged, and it is still why the account's own route needs the alt mempool. `vajra exit-e2e` shows, in one slot with a thief transaction pending, the account's escape refused by the canonical mempool, and the exit's escape admitted by it and mined. **So an escape from the exit does not need the alt mempool,** and we would rather say so than have it found.

**Why keep the first?** The account's route costs nothing until it is used, needs nothing set up in advance, and can do everything the master key can. The exit protects only an account that prepared, and an owner has to fund it before the thief arrives.

**What the exit costs:**

- **ETH sitting idle.** The reserve has to cover the gas price on the day, about 0.0025 ETH for one escape at 2 gwei, and a stake of 0.012 ETH if it is to carry a recovery. An escape does not sweep them. The master key can take them back through `execute`.
- **A second tree to keep.** It is its own tree because a leaf is single-use through a nonce key, and a nonce key belongs to a sender: one tree on two senders would lose that check. Backed up apart from the master key, it is a real second way out. Kept beside it, it is a second door to the same room.
- **A second key that can act.** Whoever holds it can freeze, cancel queued spends, and send everything to the sealed harbor. They cannot take anything, unless they hold the harbor too. It cannot cancel a recovery: that stays with the master key, because a paper gets one attempt. So an owner banned from the account's route, with a stolen paper queued, cannot veto it from the exit. The answer then is to escape.
- **Gas.** The frame walk leaves about 18,000 less for hashing, so a digest over 430 hashes is redrawn. That costs a hash, and leaves little room under the cap.

Every way we could think of to reach it is in `vajra exit-e2e`. The daily key cannot name an exit, replace its tree, or send from its address. A signature from another tree, or for the account's digest, dies. The exit key cannot unfreeze, spend, replace a key, move the harbor, send value, or call anything else.

A recovery through the exit runs the account's own check, shape and all, through `checkRecovery`. The exit key cannot reach `queueRecovery`: `validateExit` refuses the selector, so that route takes a real proof, and a ticket of its own: see section 18.

## 13. A note could be in many places at once, and could burn the owner's money

Suspected by a review of the unshield nonce key, then reproduced. **Real, and the review found half of it.** Against the V2 bytes before the fix, kept in `artifacts/VajraAccountV2.pre-fix.json` (`vajra proof-spam`, `docs/evidence/proof-spam-pre-fix-latest.json`):

- **One note, many transactions.** The nonce key had the recipient in it, so an outside depositor with one note could prove it to six recipients and have all six pending at once. 6 of 6 admitted, 6 counted as seen against the account, each owed out of its balance, and keyed transactions are exempt from the per-sender cap. So one note feeds sections 10 and 11, with no key at all.
- **A note could burn the owner's money.** This is what the recipient in the key was for, and it is worse than what it protected. A reverting recipient left the note unspent, so that a fresh proof could pay someone else. But the account pays the fee, and a note only covers it when it is spent. A holder with one note and three contracts that refuse payment burned 0.0072 ETH of the owner's balance in 3 tries at the top of the fee cap, and the note was still good. `docs/ZK.md` said nobody could use the pool to burn the owner's money. That was wrong.

**Weighing the two keys.** The recipient-bound key stops no copy of a proof: a proof is already bound to its recipient, and a copy moved to another address dies with `ShieldProofInvalid` under either key. What the key bought was a retry after a recipient refused. The nullifier alone gives that up, so a note has one mined attempt. To keep that from being a trap, `unshield` no longer reverts once VERIFY has passed:

- The note is spent whatever the recipient does. If it refuses, the money stays in the account and the holder has lost the note. `vajra unshield` asks the recipient first.
- The copy attack in section 8 stays closed, because the gas is still pinned. VERIFY checks everything `unshield` checks, against the same state.
- Our first version of this could still be made to revert, and an independent review of the fix found both ways. A recipient returning a huge blob ran the frame out of gas in the copy, so the call is now in assembly and copies nothing. And the circuit takes any field element as a recipient, so high bits passed the proof and failed the decoder. VERIFY now refuses them.

Same attacks after the fix: 1 of 6 admitted, the rest `Frame transaction cannot be replaced: fee too low`. One mined attempt at a refusing contract, the note spent, the second refused. The account's balance fell by a 0.0027 ETH fee and it keeps the rest of the note, so the holder paid. `vajra shielded` now attempts a second valid proof to another recipient, before and after the note is spent, and the old key.

**What is left.** A second proof with a 10% higher fee is a replacement, and counts as seen until the sidecar rule is in. Fees run out at the proof cost cap, a few rungs above an honest fee. Anyone can do the same to a pending proof transaction, since nothing signs its fee.

## 14. A recovery ticket stayed open after it was used

Suspected, then reproduced. **Real, and small.** The ticket went public with the first recovery, and the gate stayed open, so anyone could put a junk proof behind it on a fresh nullifier and have a node run a pairing for free. Against the bytes before the fix: `RecoveryProofInvalid`, after the pairing. After it: `RecoveryGateInvalid`, for a hash.

**The fix:** `queueRecovery` closes the gate. Nothing else does, so a rotation of the key tree leaves an unused paper exactly as it was. `vajra recover` rotates a tree, then recovers with the paper set before it. The next paper comes from `setRecovery`, signed by whichever tree is current, and `vajra recover` does that too, from the rotated tree.

A used paper cannot be set again, and the contract now says so: `RecoveryAlreadyUsed`. Its nullifier is spent and its ticket public, so it would have armed a recovery that could never work. A paper is good for one recovery.

**What is left.** While a recovery is pending its ticket is public and the gate is open, so a junk proof still costs a pairing until the block lands. Closing it needs state, and VERIFY cannot write.

## 15. A wallet signed 32 bytes it could not show

Not an exploit: a hole in what the daily key's owner can check. `personal_sign` of a digest shows a hash, so a person approving a spend was trusting the page. On V2 a wallet now signs EIP-712 typed data: `DailySpend(asset, recipient, amount, nonce, fees, gas)`, or `DailyExecute(id, ...)`.

The account rebuilds the digest from the frames, as before. It hashes the arguments as the raw words in the frame and pins the exact length, so a copy with dirty high bits in an address word no longer matches what was signed. Decoded, that copy would have passed VERIFY and reverted in the SENDER frame, spending the nonce and fee.

`vajra clear-sign`: a typed spend and a typed execute mined, and every attack refused (section 16 adds to this list): a signature moved onto another recipient or amount, another fee, cut gas, dirty high bits, trailing bytes, a no-op frame, another account, another chain, another key, and the old blind `personal_sign`, which V2 no longer takes.

V1 keeps `personal_sign`, because that is what it rebuilds, so the old path stays in `packages/core` for V1 accounts. A client tells them apart by asking for `eip712Domain()`. A node that lies about that gets a signature the account refuses. The direct form with an empty `msg`, which the CLI uses, is unchanged.

**The wallet in that run is scripted,** with viem's `signTypedData`. What MetaMask actually displays has not been checked since this change. An amount shows as a raw integer in wei, and ETH as the zero address.

**Also found on the way,** two of them by that same review:

- `validateMaster` on V2 passes the 99,900 limit at about 625 hashes, measured, and sooner on the rotation leaf, and the CLI allowed 660. An unlucky digest would have been signed, revealing a leaf, and refused. `vajra recover` hit this on a rotation. The limit is now 520 where V2 is used.
- **Open:** the signature blob sits outside the signature hash and is charged by the byte, so anyone can pad a copy of a master or exit transaction, once per signature, and burn up to what the transaction size limit allows from its payer. Traced in the client's code, not run. A length check in VERIFY is the fix, and we tried it: the extra helper call costs about 4,000 gas, which broke the rotation leaf and left the exit no digests worth drawing, so it is out. The exit's reserve should cover this.
- `validateDaily` skipped every frame that was not SENDER. V2 now refuses all but VERIFY and SENDER, in case a mode we have not read runs as the sender. No attack is known. Section 19 lets two DEFAULT frames back in, on conditions.

## 16. A stranger could raise the cost of a wallet's spend until it failed

Found by a third independent review, shown with mocked frame opcodes. **Real, and it undid what section 15 claimed**: that a copy could no longer spend the nonce and fee and pay nobody.

A wallet signs a digest rebuilt from the body frame and the fees. Frame 0 and the signature entries were in no field. So a stranger could copy a wallet-signed spend, pad frame 0's data or add an entry, and the digest stayed the same. Each byte raises the transaction's maximum cost, up to `maxDailyTxCost`. APPROVE takes that whole cost from the balance and refunds it only at the end, so a spend of nearly the whole balance reverted in the SENDER frame, with the nonce and fee gone. The direct form with an empty `msg` was never exposed: a new entry changes the signature hash.

**What ethrex does.** In `crates/common/types/transaction.rs`, `total_gas_limit` is `max(mandatory + data + execution + state, mandatory + 64 per byte + state)`, and MAX_COST is that times `max_fee_per_gas`, plus the blob cost. So padding does move it: at least 4 gas a byte, and an extra entry at least 100 plus its bytes. A blob or a recent-root reference moves it too. Reading it turned up two things the proposed fix did not have:

- **MAX_COST cannot simply be signed.** Data costs 4 gas for a zero byte and 16 for any other, and `msg` and the signature are data. So the cost depends on the digest, and the digest on the cost. The signature's first byte is `v`, which is zero half the time, so an exact commitment would have failed about half of all signatures. The wallet signs the cost as if those 97 bytes hold no zero. Once it has signed, `withTypedSignature` adds 3 zero bytes to frame 0 for each zero byte found, 12 gas each, and the cost lands exactly on what was signed. `validateDaily` ignores them.
- **Some changes leave MAX_COST where it was.** Padding paid for by cutting frame 0's limit keeps the sum the same, and turns unused VERIFY gas into gas burned. So frame 0's limit is signed too, as `verifyGas`.

**The fix:** `DailySpend` and `DailyExecute` gain `verifyGas` and `maxCost`, and `_typedDigest` reads both from the transaction. With the fee and all the limits signed, the intrinsic cost is fixed, so no copy can add to it. V2 has only this digest: it has no `personal_sign` path to change, and refuses that form, as section 15 says. V1 is unchanged, and keeps this hole.

`vajra clear-sign` sends each of these and gets `SignatureNotBoundToTransaction`: frame 0 padded by one byte, padded towards the cap, its limit raised, its state limit raised, an entry added, and padding traded against the limit with the cost held still. It also checks the node's own maximum cost against what the wallet signed, and mines a spend that leaves the balance room for the signed cost and no more, after refusing the padded copy of it.

**What is left.** A copy can still swap the 3-byte fillers for something of the same cost, or flip `validateDaily`'s scope word. Neither changes what is paid, and a wrong scope never gets a payer. The wallet now shows two more numbers. MetaMask has not been run against this change.

## 17. One solved proof of work bought many pairings

Found by the same review, shown with the real verifier. **Real, and small.** The hash for `validateUnshield`'s `work` held the proof and the nonce key, and the nonce key holds only the nullifier. So one solved number passed for every known root and every recipient, and each of those reached the pairing, on a proof that could not verify.

**The fix:** the hash now holds the root, the nullifier and the recipient as well. `proofWork` in `packages/core/src/zk.ts` matches. `vajra shielded` spends a solved number on another recipient and another root, and gets `ProofWorkMissing`.

**What is left.** About one variant in 2^`PROOF_WORK_BITS` passes by chance, and a GPU is faster than this toll assumes, as the contract says. The fee is not in the hash, so a pending junk proof can be replaced at a higher fee and run its pairing again, up to the proof cost cap. See section 13.

## 18. A stranger could make the exit's reserve pay for a recovery

Found by the same review. **Real, and small.** A recovery sent from the account is public, proof and ticket. Nonce keys are per sender, so a stranger could resend the same two from the exit, and the reserve paid up to 0.005 ETH, with no key and no secret. Only once, because the nullifier is then spent, but that is twice what one escape needs.

The proof binds the account, not the sender, and changing the circuit means a new setup. What separates the paper from a stranger is the ticket, so **the exit takes a different one**. A paper now makes two tickets, and the account's is the hash of the exit's:

    exitTicket     = keccak("vajra-recovery-ticket" ‖ secret)
    recoveryTicket = keccak(exitTicket)
    gate           = keccak(recoveryTicket)

`VajraExit.validateRecovery` hashes what it is given and passes that to `checkRecovery`. So a ticket seen on the account is no use at the exit, which needs its preimage. Nothing else changed: no new storage, no new argument to `setRecovery`, and the same gate on the account. The owner of a banned account still has the exit, because the paper makes both. `vajra exit-e2e` resends a seen ticket from the exit and gets `RecoveryGateInvalid`, and `vajra rep-burn fixed` is what recovers from the exit with the account banned.

**What is left.** It goes one way only. A recovery from the exit shows `exitTicket`, and anyone can hash that and resend the proof from the account, which then pays up to 0.005 ETH. And nothing signs a proof's fee, so a stranger can raise the owner's own exit recovery to the 0.005 ETH cap. A reserve meant to fund a recovery and then an escape should hold about 0.0075 ETH. A gate set before this change has no exit ticket: the mirror starts empty and no V2 is on the public devnet, so none exists.

## 19. V2 could not take a sponsored daily transaction

Found by the same review. A failure to work, not an attack. V2's walk refused the DEFAULT frames in `[only_verify, charge, pay, SENDER..., settle]`, so `vajra paymaster-e2e` ran on V1, where the walk skips them.

**Skipping them is not safe, which is why V2 stopped.** A DEFAULT frame runs as the entry point with no value, so it has no authority over the account. But a paymaster reads the sender from it, and takes what that sender approved. So on V1 a stolen daily key can spend the approved USDC on gas, outside the rulebook, as "What the account cannot do" says. Simply allowing DEFAULT frames would have given V2's daily key a power it did not have.

**The fix does what that section said the real fix was,** plus one rule:

- A DEFAULT frame passes only at frame 1 or the last frame, only with the daily frame first and at scope EXECUTION, and only to a paymaster the master key named with `setSponsor`. The daily key cannot reach `setSponsor`.
- The cost cap now holds at every scope, so what a paymaster takes for gas is held to `maxDailyTxCost`.

An account that names nobody refuses every DEFAULT frame, as before, so a daily signature on it approves nothing new. A wallet signature is still pinned to `[VERIFY, SENDER]`. `vajra paymaster-e2e` now runs on V2. It tries an account that named nobody, an unnamed paymaster, the daily key naming one itself, and a DEFAULT frame in the body. Extra collect frames now die in VERIFY, where on V1 they mine and fail.

**What is left.** Naming a paymaster is a real grant. A stolen daily key can then spend what the account approved to it on gas, up to `maxDailyTxCost` a transaction, with no limit on how many, and use up the day's quota. The tip part can reach a colluding block producer, up to the paymaster's `feeCap`. So keep the approval small, and name only what the daily key should use. V1 keeps its gap: `VajraAccount` is unchanged. And only the two frames' positions and target are held: what they do is up to the named paymaster.

**The fixes in sections 16 to 19 are in the V2 deployed on the public devnet on 6 November, but only recovery and one note were run there. Their tests ran on the mirror.** They have had no second independent review, and nothing here has been audited.
