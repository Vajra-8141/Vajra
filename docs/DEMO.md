# Demo runbook

Replaces the demo in spec 03 §7. Its opening beat, the public mempool rejecting a transaction on gas while the alt mempool
admits it, does not happen on the live devnet: both refuse over 100,000 gas. See `FINDINGS.md`.

**The one line:** keep your wallet. We put a bank around it, and the vault key is one a quantum computer can't break.

The demo follows one person's money through seven moments. There is no board on the table: the master key is a software signer on the
presenter's laptop, and a phone is the owner's remote control for it. Say so.

## Not tried yet

Do these before the rehearsal. Until then, treat the matching beat as untested.

| What | Status | If it fails |
|---|---|---|
| Real MetaMask on the public chain | Worked on the mirror on 6 November in Brave, MetaMask 13.55: connect, a small spend, a queued 0.5 ETH with the alarm. Not tried on the public chain | `vajra spend` for moment 1 |
| Dashboard on the public chain | Not tested since the reset of 6 November. Tested on the mirror in a real browser | Run the whole demo on the mirror and say so |
| `vajra watch` on the public chain | Not tried. Real bot and real phone passed on the mirror on 6 November: two cancels, one payment | The same: run it on the mirror |
| A full rehearsal | Not done. The timings below are estimates | |

## Before you go on stage

Three terminals on the presenter's laptop, and the phone with Telegram open on `@VajraAlertbot`.

    alias vajra='node packages/cli/src/main.ts'
    vajra status                                  # the devnet is up, and the account is yours
    vajra bridge                                  # terminal 1
    pnpm --filter @vajra/dashboard dev            # terminal 2, http://localhost:3000
    vajra watch --allow-software-pay              # terminal 3

`.env` needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Without `--allow-software-pay` the alert still arrives, and **Pay, it's me** is refused.

1. Check the deployer has ETH, and that `vajra e2e` passes. It takes about five minutes.
2. Make a fresh demo account. Move any old `.vajra/wallet*.json` aside first. Nothing in this demo needs to mature, so use a delay long enough to survive a slow transaction:
   `vajra create --harbor 0x… --delay 300 --cooling 60 --limit 0.001 --allowance 0.0002 --fund 0.05`
3. Import `.vajra/daily.key` into MetaMask and add the devnet as a network. That key is the "stolen" one. Select that network, or the signature popup will name whichever one was last open, and connect only that account to the page.
4. Fire one test theft and tap **Not me**, to prove the phone is connected.
5. Let the dashboard finish connecting to Nym, up to a minute. If it will not come up, pick a route marked not private, and say so.
6. Have `docs/evidence/` open, and logs of `vajra compare`, `vajra recover` and `vajra shielded` from a mirror run. Those take a minute or more each, so do not run them live.

**Run moment 4 last on the public account.** Escape really does send everything to the harbor, and the account is finished after that.

**Answer on the phone.** The dashboard's alarm only warns: it goes red, beeps and tells you to check your phone. The **Who signed** panel picks up phone taps and the thief's terminal within a few seconds, and the alarm can take up to about 10 seconds to show. The watcher must be running before anything is queued, or the alert only goes out once it starts.

**About one transaction in twenty is cancelled by the node.** `submit` rebroadcasts the same bytes on its own, which adds about
30 seconds. It is not a failure. Say what is happening if it lands on stage.

## The seven moments

| # | What happens to you | What VAJRA does | Who signs | Where it runs |
|---|---|---|---|---|
| 1 | You spend as normal | MetaMask works as usual, inside a daily limit | secp256k1 | Public |
| 2 | Your seed gets stolen, and the thief sends a big payment | It waits in a public queue, and your phone buzzes | secp256k1 | Public |
| 3 | **You cancel it from your phone** | **The hash key outranks the wallet** | **Hash key** | Public |
| 4 | The thief tries to block your exit | The alt mempool carries your escape to the harbor | Hash key | Public |
| 5 | Someone pays you privately | Stealth payment, gas paid by a paymaster, no ETH anywhere | Hash key plus co-signature | Public |
| 6 | You lose the master key | A proof of your paper secret installs a new one | No key, only a proof | Mirror |
| 7 | You want private savings | A pool that freeze and escape still control | No key, only a proof | Mirror |

Moments 1 to 4 are the safe account, 5 is private receiving, 6 and 7 are recovery and private holding. One account, and each step builds on the last.

## The four minutes

| Time | Moment | Say or do | On screen |
|---|---|---|---|
| 0:00 | | "Your seed phrase gets stolen. In every wallet in this room, that is the end. Here, the thief gets a day's limit." | Dashboard |
| 0:15 | 1 | A small payment, signed in MetaMask. "Nobody switches wallets. Nothing about daily life changes." | MetaMask popup, then **Who signed**: Daily key |
| 0:30 | 2 | A teammate plays the thief: `vajra thief 0.005`. Same key, far over the limit. The laptop beeps, the page goes red, and the phone buzzes. Hold the phone up. "The thief has your key, but the theft has to wait in public. So your account can warn you." | Red alarm, queue countdown, the phone |
| 0:55 | 3 | Tap **Not me**. "That tap made a hash key sign." Stop here and read the **Who signed** panel aloud. "Same account, two kinds of signature, and the hash one is in charge. The wallet you know is now the junior key." | **Who signed**: both rows, the table below |
| 1:20 | 3 | "And if it really was you?" The teammate runs `vajra thief 0.005` again, and you tap **Pay, it's me**. It leaves now, without waiting out the delay. | Recipient balance |
| 1:40 | | "So the thief goes after the rules." The attacks: harbor, keys, limits, a second frame paying themselves. Each dies in validation, by name. | `vajra e2e` output, or the proof page |
| 1:55 | 4 | **The moment.** "The thief keeps a transaction pending, and the public mempool will not take your escape." The same signed bytes go to the alt mempool. Admitted, mined. "That is why this has to exist." | `vajra pin`, split screen |
| 2:20 | 5 | The track author's request: a stealth payment over ML-KEM, spent with a hash signature and a co-signature, gas paid by a paymaster. | `vajra stealth` |
| 2:40 | 6 | **The upstream finding, and recovery.** "Everything so far ran on your public devnet. Here is what your deployed sidecar does with a proof." Show it refused at the 100,000 cap. "Here is our patch, which restores your own spec, and you okayed a local sidecar for judging." The same bytes mine, at 298,000 gas. The master key is gone, and a proof queues a new tree behind the same veto. | `vajra compare`, then the recover log |
| 3:10 | 7 | **The rulebook survives inside the shielded world.** A valid unshield, refused because the account is frozen. Escape: the pool lands in the harbor. "Groth16 is not post-quantum, and the anonymity set is tiny, and we will tell you exactly what it does not hide." | `vajra shielded`, steps 6 and 7 |
| 3:35 | 4 | Press escape for real, and the funds land in the sealed harbor. | Harbor balance |
| 3:45 | | Say what this does not prove, starting with the bugs review found after every test passed. Close on the one line. | README section |

Moments 6 and 7 are on the local mirror: chain 13370, 2-second blocks. Say so.

### The switch to read aloud at 0:55

Both signed the same account, on the same chain.

| | Daily key | Master key |
|---|---|---|
| Signature type | secp256k1 | Winternitz hash key |
| Quantum computer can break it? | Yes | No curve to break |
| Signature size | 65 bytes | 2,144 bytes |
| Gas to verify | 33,000 to 36,000 | about 90,000 |
| Can it change the rules? | No | Yes |

## If something breaks

**MetaMask fails:** `vajra spend 0xAddress 0.0001` from a terminal, and say the wallet would sign the same thing.

**The alert does not arrive:** the laptop beep and the red page come from the dashboard, which reads the same queue. Use the **Veto** button in the queue list, and say what you are doing. Check terminal 3 afterwards.

**The public devnet is down or resets:** `vajra deploy` restores the contracts in one command, for about 0.1 ETH. If there is no ETH, use the mirror:

    make judge
    make dashboard                                # own terminal. With a bot in .env it starts the watcher too

Then the same beats with `VAJRA_STACK=local`, and say that it is local. The page shows a banner saying so. Reads are direct, not over Nym, and the proof page shows 0 confirmed, because it looks up public transactions.

**Nothing runs:** the proof page and `docs/evidence/`. The explorer keeps its history in memory, and a devnet reset wipes everything.

## Say these first, before anyone asks

- **"The master key here is software, on this laptop."** So in this demo a phone tap really can move money, through `--allow-software-pay`. Without that flag **Pay** is refused. The design for a real user puts a hardware signer behind Pay, and we are not showing one today.
- **"Telegram is a convenience, not part of the security."** It carries an alert and a button press. The rules live in the contract, and a queued item still waits and can still be cancelled if the alert never arrives. The watcher has to be running for the phone to work.
- **"Reviews of our own code found two critical bugs in the contract we first deployed."** A thief with the daily key could disable the master key, and a stealth payer could take the money back. Both were reproduced on the mirror and are fixed in what is deployed now. `docs/FINDINGS.md` sections 8 and 9.
- **"The devnet was reset on 6 November."** Earlier transactions are gone from the chain. `vajra e2e`, `pin` and `stealth` were rerun on the new one. Records of the rest are in `docs/evidence/`.
- **"A thief still gets the daily limit."** A spend under the limit leaves at once, so the alert cannot stop it. That is the price of a wallet that works normally.
- **"Groth16 is not post-quantum."** The recovery path is weaker against a quantum computer than the key it replaces. v2 is a STARK, and it is not built.
- **"The pool hides which deposit paid, not that this account paid that recipient."** That is the price of a pool the rulebook can govern.
- **"Recovery and the pool run locally."** The deployed sidecar refuses them, and the EF said a local sidecar is fine for judging.
- **"The trusted setup has one contributor, us."**
- **"We measured, and post-quantum signatures do not have to exceed the budget."** At w=16 the full verification costs about
  90,000 gas and fits under the 100,000 cap. The reason we need your mempool is the blocked exit, not the gas.
- **"The deployed sidecar caps validation at 100,000 even for staked senders."** ERC-8421 says 1,000,000. We have a patch.
- **"The blocked escape lasts as long as a thief transaction is pending."** On this idle devnet that is one slot, so the thief
  has to keep sending, at the victim's expense.
- **"Balances are public, and sending shows your IP to the mempool."** Reads go over the mixnet. STARK recovery is designed, and no STARK proof exists.

## Questions to expect

**Why not just use MetaMask?** You do. MetaMask stays your daily wallet. It cannot warn you, because a stolen key looks exactly like you, and nothing in a plain account makes a theft wait.

**What if the thief steals the phone too?** With a software signer, a stolen phone plus a stolen daily key could empty the account. That is why Pay needs a hardware signer unless someone turns that off, as we did here. **Not me** is the safer button: it can only stop a payment.

**Why Telegram?** It gave us a real push and buttons in a day, and the laptop only makes outbound connections. Any channel would do.

**The MetaMask popup only shows a hash. How do you know what you signed?** You don't, from the popup: it is a `personal_sign` of a digest. That is a real weakness of using a plain wallet as the daily key. The rules are the answer: a page that tricks you into signing a large payment still only reaches the queue, and your phone still buzzes.

**Why does the chain say "vetoed" for a payment I approved?** Pay is one atomic transaction: it cancels the queued item and sends the money itself, so the queue can never pay twice. Check the recipient's balance.

**Where is the hardware?** A signer exists: `firmware/`, with a run on a real ESP32 in `docs/evidence/` from before the reset. It is not on the table, and the build with the Pay screen has not been flashed. Plugged into a compromised computer, that board gives up its key: any program there can copy it over USB in half a second and press BOOT for it. It is a prototype.

**Why not w=256, as in your earlier plan?** It costs about 330,000 gas, and no mempool admits that today. It saves 1 KB of
signature and costs 3.7 times the gas. If the sidecar gets per-entity budgets, it becomes possible, but w=16 is still the better
choice on gas. `len2` and `logW` are constructor arguments, so it is a redeploy, not a rewrite.

**The sender derives your stealth key, so can it not spend?** It knows the hash key, which is why that key alone is not enough.
Spending also needs ERC-8441's stealth key, which the sender cannot compute. The first deployed contract only checked this on the linear nonce: see `FINDINGS.md` section 9. Now it is refused on both. The remaining
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
