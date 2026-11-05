# Demo runbook

Replaces the demo in spec 03 §7. Its opening beat, the public mempool rejecting a transaction on gas while the alt mempool
admits it, does not happen on the live devnet: both refuse over 100,000 gas. See `FINDINGS.md`.

Every beat below has run on the live devnet. If the hardware is on the table, run the bridge with `VAJRA_SIGNER=device` and
press BOOT for each master operation. Rehearse that first: the board has signed through the CLI, not yet through the bridge.
Otherwise the master key is a software signer, so say that.

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
| 0:00 | "Your seed phrase gets stolen. In every wallet in this room, that is the end. Here, the thief gets a day's limit, and when you press escape, they cannot stop you." | Dashboard |
| 0:30 | A normal spend, signed by MetaMask. Nothing about daily life changes. | Sign and send |
| 0:50 | Now the thief, with the same key, sends something large. It is not refused: it joins a public queue and starts counting down. "You don't need to notice the theft. The theft has to announce itself and wait." | Queue, countdown |
| 1:20 | Veto it. Signed by a key made of hashes, verified inside the account. | Veto, then the VERIFY gas in the log |
| 1:40 | "So the thief goes for the exit." Run the attacks: harbor, keys, limits, a second frame paying themselves. Each one dies in validation, by name. | `vajra e2e` output, or the proof page |
| 2:10 | **The moment.** "Here is the attack that needs the alt mempool. The thief keeps a transaction pending, and the public mempool will not take your escape." | `vajra pin`, split screen |
| 2:40 | The same signed bytes, offered to the alt mempool. Admitted, mined. "That is why this has to exist." Then press escape for real, and the funds land in the sealed harbor. | Escape, harbor balance |
| 3:10 | The track author's request: a stealth payment received over ML-KEM, spent with a hash signature, gas paid by a paymaster, no ETH anywhere. | `vajra stealth` |
| 3:40 | Say what this does not prove. Close. | README section |

## Say these first, before anyone asks

- **"We measured, and post-quantum signatures do not have to exceed the budget."** At w=16 the full verification costs about
  90,000 gas and fits under the 100,000 cap. The reason we need your mempool is the blocked exit, not the gas.
- **"The deployed sidecar caps validation at 100,000 even for staked senders."** ERC-8421 says 1,000,000. We have a patch.
- **"The blocked escape lasts as long as a thief transaction is pending."** On this idle devnet that is one slot, so the thief
  has to keep sending, at the victim's expense.
- **"The master key here is software."** Unless the hardware is on the table.
- **"Plugged into a compromised computer, this board gives up its key."** Any program there can copy it over USB in half a
  second and press BOOT for it. The signer keeps the key off the machine the rest of the time. It is a prototype.
- **"Balances are public, and sending shows your IP to the mempool."** Reads go over the mixnet. Hidden balances and STARK
  recovery are designed. No proof exists.

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

**What happens when the tree runs out?** The last leaf can only install a new tree, and rotation is tested live.

**Why not replace the thief's transaction with a fee bump?** An escape on the linear nonce could, but then it is a fee war
against someone spending your money, and it gives up the keyed nonce that makes each leaf single-use at the protocol level.
