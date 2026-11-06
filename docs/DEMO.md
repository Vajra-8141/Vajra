# Demo runbook

Replaces the demo in spec 03 §7. Its opening beat, the public mempool rejecting a transaction on gas while the alt mempool
admits it, does not happen on the live devnet: both refuse over 100,000 gas. See `FINDINGS.md`.

Every beat below has run on the live devnet, except the two marked as local. If the hardware is on the table, run the bridge with `VAJRA_SIGNER=device` and
press BOOT once each time the screen shows `BOOT = approve`. Otherwise the master key is a software signer, so say that.

## Before you go on stage

    alias vajra='node packages/cli/src/main.ts'
    vajra status                                  # the devnet is up, and the account is yours
    vajra bridge                                  # own terminal
    pnpm --filter @vajra/dashboard dev            # own terminal, http://localhost:3000

1. Check the deployer has ETH, and that `vajra e2e` passes. It takes about five minutes.
2. Use short delays on the demo account so the queue visibly counts down:
   `vajra create --harbor 0x… --delay 120 --cooling 60 --limit 0.001 --allowance 0.0002 --fund 0.02`
3. Let the dashboard finish connecting to Nym before you start, up to a minute. If it will not come up, pick a route marked
   not private, and say so.
4. Have `docs/evidence/` open. The explorer keeps its history in memory, and a devnet reset wipes everything.

**If the devnet is down or resets:** `vajra deploy` restores the contracts in one command, but it costs about 0.1 ETH and the
faucet has been dry. Failing that, the proof page and `docs/evidence/` are the fallback.

**About one transaction in twenty is cancelled by the node.** `submit` rebroadcasts the same bytes on its own, which adds about
30 seconds. It is not a failure. Say what is happening if it lands on stage.

## The four minutes

| Time | Beat | On screen |
|---|---|---|
| 0:00 | "Your seed phrase gets stolen. In every wallet in this room, that is the end. Here, the thief gets a day's limit." | Dashboard |
| 0:20 | A normal spend, signed by MetaMask. Nothing about daily life changes. | Sign and send |
| 0:35 | Now the thief, with the same key, sends something large. It joins a public queue and starts counting down. "The theft has to announce itself and wait." | Queue, countdown |
| 1:00 | Veto it. Signed by a key made of hashes, verified inside the account. | Veto, then the VERIFY gas in the log |
| 1:15 | "So the thief goes for the exit." The attacks: harbor, keys, limits, a second frame paying themselves. Each dies in validation, by name. | `vajra e2e` output, or the proof page |
| 1:40 | **The moment.** "The thief keeps a transaction pending, and the public mempool will not take your escape." | `vajra pin`, split screen |
| 2:05 | The same signed bytes, offered to the alt mempool. Admitted, mined. "That is why this has to exist." Press escape for real, and the funds land in the sealed harbor. | Escape, harbor balance |
| 2:30 | The track author's request: a stealth payment over ML-KEM, spent with a hash signature, gas paid by a paymaster, no ETH anywhere. | `vajra stealth` |
| 2:55 | **The upstream finding, and recovery.** "Everything so far ran on your public devnet. Here is what your deployed sidecar does with a proof." Show it refused at the 100,000 cap. "Here is our patch, which restores your own spec, and you okayed a local sidecar for judging." The same bytes mine, at 298,000 gas. The master key is gone, and a proof queues a new tree behind the same veto. | `vajra compare`, then the recover log |
| 3:20 | **The rulebook survives inside the shielded world.** A valid unshield, refused because the account is frozen. Escape: the pool lands in the harbor. "Groth16 is not post-quantum, and the anonymity set is tiny, and we will tell you exactly what it does not hide." | `vajra shielded`, steps 6 and 7 |
| 3:45 | Say what this does not prove, starting with the flaw in the deployed contract. Close. | README section |

Timings are tighter than before, to fit the two new beats in four minutes. Stealth and the attacks gave up the most.

Run `make judge` and `make unpatched` before going on stage, and have logs of `vajra compare`, `vajra recover` and `vajra shielded` open. Those runs take a minute or more each, so
do not run them live. Beats 2:55 and 3:20 are on the local mirror: chain 13370, 2-second blocks. Say so.

**If the public devnet is down:** the mirror runs every beat. `make judge`, then run the same commands with `VAJRA_STACK=local`, and say that it is local.

## Say these first, before anyone asks

- **"A thief with the daily key can disable the master key on the deployed contract."** They spend the master key's public nonce keys. We found it reviewing our own new code,
  reproduced it locally, and fixed it in the source. `docs/FINDINGS.md` section 8. **Until `stack/redeploy-public.sh` has run and the demo account is new, do not say "the thief
  cannot stop your escape" without "while a transaction is pending".** After that, say what was found and fixed, and that older accounts keep the flaw.
- **"Groth16 is not post-quantum."** The recovery path is weaker against a quantum computer than the key it replaces. v2 is a STARK, and it is not built.
- **"The pool hides which deposit paid, not that this account paid that recipient."** That is the price of a pool the rulebook can govern.
- **"Recovery and the pool run locally."** The deployed sidecar refuses them, and the EF said a local sidecar is fine for judging.
- **"The trusted setup has one contributor, us."**
- **"We measured, and post-quantum signatures do not have to exceed the budget."** At w=16 the full verification costs about
  90,000 gas and fits under the 100,000 cap. The reason we need your mempool is the blocked exit, not the gas.
- **"The deployed sidecar caps validation at 100,000 even for staked senders."** ERC-8421 says 1,000,000. We have a patch.
- **"The blocked escape lasts as long as a thief transaction is pending."** On this idle devnet that is one slot, so the thief
  has to keep sending, at the victim's expense.
- **"The master key here is software."** Unless the hardware is on the table.
- **"Plugged into a compromised computer, this board gives up its key."** Any program there can copy it over USB in half a
  second and press BOOT for it. The signer keeps the key off the machine the rest of the time. It is a prototype.
- **"Balances are public, and sending shows your IP to the mempool."** Reads go over the mixnet. STARK recovery is designed, and no STARK proof exists.

## Questions to expect

**Why not w=256, as in your earlier plan?** It costs about 330,000 gas, and no mempool admits that today. It saves 1 KB of
signature and costs 3.7 times the gas. If the sidecar gets per-entity budgets, it becomes possible, but w=16 is still the better
choice on gas. `len2` and `logW` are constructor arguments, so it is a redeploy, not a rewrite.

**The sender derives your stealth key, so can it not spend?** It knows the hash key, which is why that key alone is not enough.
Spending also needs ERC-8441's stealth key, which the sender cannot compute. Refused live with `CoSignerRequired`. The remaining
case is a sender who also owns a quantum computer. See `STEALTH.md`.

**Why not rotate your keys before Q-day?** Rotation is a transaction, and on the day it matters that transaction exposes your
key in the mempool. It is also advice rather than a mechanism. The same gap exists today: a drainer with your seed holds a key
equal to yours, and only a second factor enforced in validation can outrank it.

**What if someone restores a backup of the key?** That is the failure one-time keys cannot survive, and the chain cannot catch all of
it: a signature that was revealed and never mined leaves no trace there. Every signature is published on Arkiv and checked before
signing. `vajra arkiv` shows a restored copy moving past a key the chain still thinks is unused. See `arkiv/why-arkiv.md`.

**Why Groth16 and not a STARK?** It was what could ship, and it is labelled. On-chain STARK verification is millions of gas, which is the v2 and the point of the alt mempool. Not built.

**Who can spend a note?** Whoever holds it, with a proof and no key. Unless the account is frozen, or has escaped, in which case nobody can.

**What stops someone copying a proof from the mempool?** A proof has no signature, so VERIFY pins everything one would commit to: the frames, the arguments, the gas, the nonce key and a fee cap.

**What happens when the tree runs out?** The last leaf can only install a new tree, and rotation is tested live.

**Why not replace the thief's transaction with a fee bump?** An escape on the linear nonce could, but then it is a fee war
against someone spending your money, and it gives up the keyed nonce that makes each leaf single-use at the protocol level.
