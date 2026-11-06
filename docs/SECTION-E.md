# Section E: where the work stands

First written on 2026-11-07 at about 01:16 IST, when the owner stopped the work in progress. Brought up to date at about 05:00 IST, after the full reruns, every security review and their fixes. It records what is done, what is proven, and what is not. Everything here is on branch `section-e`, and `section-e-pool` is the same commit. Neither has been pushed, and `main` is untouched.

| Item | Status |
|---|---|
| 1. leanSphincs-S benchmark | **Done, and shown to the owner** |
| The V2 fix from item 1's review, `docs/FINDINGS.md` section 21 | **Done in the source. Not on the public devnet: that needs a redeploy** |
| A thief hiding a theft from every alert, section 22 | **Found and fixed in the client, and two ways back in fixed after the review** |
| 2. Nominee | **Built, reviewed, with the reviews' fixes in, and passing on the mirror** |
| 3. Better pool | **Built, reviewed with no critical or high finding, with the review's fixes in, and passing on the mirror. In this branch. Not on the public devnet** |
| `escape` pays the harbor before the tokens, which the owner chose | **Done in the source, and proven at the old bytes and the new. Not on the public devnet: that needs a redeploy** |
| 4. Shared pool across accounts | **On hold, by the owner, until they say otherwise.** Nothing is built. A read-only design check is in `docs/ZK.md` |
| leanSphincs-S as the exit's key, which the owner chose | **Decided, not built** |

## Commits on `section-e`

Branched from `main` at `45c1c1b`.

| Commit | What |
|---|---|
| `be1d383` | Item 1: the benchmark, and the first write-up of the named-exit flaw |
| `4ec853b` | The V2 fix: `setExit` and `queueRecovery` |
| `69d15c4` | The queue reader fix |
| `65fabb0` | Item 2: the nominee |
| `2bdbf85` | The first version of this note, and the runs finished by then |
| `61c0afc` | The rerun's evidence, and the gas table brought to it |
| `2dd2096`, `d7a7183`, `23ce916` | The second review's fixes, and the attacks it found missing, sent for real |
| `309915e` | The third review's fixes: send first, a stuck head, a kept burn, `unfreeze` refuses |
| `3649d85` to `6b32527` | Item 3, from the parallel agent |
| `1ea4c33` | `escape` pays the harbor before the tokens |
| `31acd00` | Item 3's review: the claims it showed were wrong, and the client's fixes |
| `d7e82a2` | Item 4 on hold, and an escape check that allows for the gas refund |
| `dd98341` | The fourth review: the harbor's call bounded, `chainClock`, and what an escape left behind |
| The commit after that | The final run's evidence and these docs |

## What the owner decided, on 2026-11-07

1. leanSphincs-S becomes the exit's key, and not a second master key in V2.
2. The section 21 fix goes in at the next redeploy. It is in the source. The redeploy has not happened, and only the owner decides that.
3. Start the nominee. Then start item 3 on another agent while the tests ran. The owner stopped that agent and the second security review when usage ran out, and both started again at about 01:23 IST.
4. `escape` pays the harbor before it sweeps tokens. In the source now. The redeploy stays the owner's decision.
5. The note seed stays apart from the master seed, which departs from spec 04 section 10.3. Outsiders have no master seed, and a hardware signer never releases one.
6. `claim` stays an ordinary transaction. Its sender needs gas and is public, and the alternative reopens section 13.
7. The meter stays on the account page.
8. Item 4 is on hold until the owner says otherwise.

## Item 1: leanSphincs-S

A benchmark on the local mirror: `vajra sphincs-bench`, `docs/GAS.md`, `docs/FINDINGS.md` section 20, `docs/evidence/leansphincs-gas-latest.json`. No account relies on this key, and `VajraAccountV2` did not change for it.

| | Hash key today | leanSphincs-S |
|---|---|---|
| Bytes in the signature entry | 2,337 | 4,164 |
| VERIFY gas, veto, new nonce key | 97,293 | 101,554, over the 100,000 cap |
| VERIFY gas, veto, linear nonce | not possible: each leaf needs its own nonce key | 81,574 |
| Whole transaction, veto | 172,833 | 282,298, 63% more |
| Whole transaction, escape | 490,115 | 569,962, 16% more |
| Signing, TypeScript on one thread | 12 ms | 1.6 s |
| Signatures per key | 63, then rotate | 20,000, an unproved estimate that nothing counts |

**Proven on the mirror:** it fits a VERIFY frame with no stake if its sender keeps one nonce, and both mempools mined it. Signing again after revealing a signature, a fee bump, and a key restored from its seed all mined. A real V2 account vetoed and escaped through it with no contract change.

**Not proven:** anything on the public devnet. The parameters are research parameters, and the security estimate is not proved for them. It has not run on the ESP32: the 23 seconds a signature in `docs/GAS.md` is arithmetic.

**Upstream's Rust signer was never run.** This session's permissions refused building code cloned from outside the repo. So `packages/core/src/leansphincs.ts` was written from the spec, and it matches upstream's six known-answer vectors byte for byte. Upstream's 7 to 29 ms a signature stays upstream's claim.

**A claim that was wrong, and was corrected.** The first write-up said leanSphincs-S was cheaper to verify. It had compared a linear nonce with a keyed one. Like for like, a payment costs the same and a veto 4% more. The independent review caught it.

## The V2 fix: section 21

The independent review of item 1 found that a named exit with no walk over its frames could call `queueRecovery` with no proof. With no paper set the delay is 0, so that replaced the master tree in one transaction. It was reproduced on the mirror. It needs a master signature on the wrong address.

- `setExit` now asks the contract for its `account()`, and refuses another answer: `ExitNotForThisAccount`.
- `queueRecovery` now refuses with no commitment set: `RecoveryNotSet`.
- The bytes before the fix are kept in `packages/core/src/artifacts/VajraAccountV2.pre-section-21.json`, so that `vajra sphincs-bench` step 8 can show the flaw and then the fix.
- V2's code went from 23,178 to 23,332 bytes.

**What is left:** a contract written to lie passes the `account()` check, and with a paper set it can still spend that paper. A test holds that as the known limit.

**The V2 deployed on the public devnet still has this flaw,** and the hosted demo runs that V2.

## The queue reader: section 22

Found while building the nominee, then reproduced on the mirror with only the daily key. One transaction with thirteen `spend` frames pushed the theft out of the "newest 12" that every reader used: the phone alert, the push service, the extension, the bridge and the dashboard's alarm. No alert would fire, and the theft would mature in silence.

`readAccount` now reads every item that may still be waiting. No contract changed. A client that has not been updated, such as a hosted dashboard, still has the bug.

The second review found two ways back in, both fixed. The mark that saves reading settled items counted `None` as settled, and it outlived a chain reset.

## Item 2: the nominee

Section 23 of `docs/FINDINGS.md` has the full write-up. The exit's key signs one transaction in advance: an `escape`, from the exit. Someone the owner trusts holds it, with no key. If a queued item is still waiting close to the end, nobody answered, and the rescue goes. No contract changed for this.

What was built:

| What | Where |
|---|---|
| Signing, reading and checking a rescue | `packages/core/src/rescue.ts` |
| `vajra nominee-setup`, `nominee-check`, `nominee-watch`, `nominee-revoke` | `packages/cli/src/nominee.ts` |
| The nominee's page, which needs no wallet | `apps/dashboard/app/nominee/page.tsx`, **Your nominee** in the menu |
| A line in the owner's alert saying when the rescue goes | `packages/cli/src/watch.ts`, `phone.ts` |
| The live suite, and every attack on it | `packages/cli/src/nominee-e2e.ts` |
| The browser test | `apps/dashboard/test/nominee.mjs` |

**Proven on the mirror, on the committed code:** `vajra nominee-e2e` gave 42 mined, 22 refused, 0 failures, in 742 seconds, and it is recorded in `docs/evidence/nominee-latest.json`. It uses a real process that holds no key. In that run:

- The owner answers both ways, and nothing is sent.
- Nobody answers, with a thief sending a transaction every second. The rescue landed with 10 seconds of its 15-second margin left. A thief's transaction was in the node's pool in 24 of 48 looks, so "pending the whole time", which an earlier version of this suite said, was never true.
- A theft hidden behind a dozen more, on an account that could really pay it, holding tokens. The rescue lands first, every wei reaches the harbor, and the thief's collection dies.
- A stolen recovery paper on a frozen account. The money reaches the harbor before the thief's key tree can act.
- A rescue that would fail is reported and not sent.
- `setRoot` ends every rescue, and a new one works, and so does the real `vajra nominee-revoke`.
- A node that will not simulate, and then dies altogether at the margin: it goes on the last good read, through the sidecar. A node stuck at one block: it still goes, with 10 seconds to spare. A sidecar that is down, and one that takes it and never relays it: the canonical mempool carried it with 12 and 8 seconds to spare. All of these are a proxy in front of the real chain, which refuses, replays an old block, and answers for a sidecar that sits on a transaction.
- A reserve too small: refused for free, and it lands once anyone tops it up. A reused leaf: not called rescued. A lost seed: refused.

The rescue took 96,934 VERIFY gas and 489,842 for the whole transaction, with up to 0.01252 ETH held against the reserve at a 10 gwei cap, and about 0.009 more for each token.

**Three reviews of this work, and each found something in the last round's fixes.** The second ran from 01:23 to about 01:53 IST, and found one high-severity way for a thief to stop a rescue firing, five of medium severity, six low, and that the suite's own attacks were weaker than their names. The third read those fixes, and found two high and three medium, each needing a bad node, a flake or a bad file. The fourth read the change to `escape` and the third's fixes, and found nothing high and two medium, one of them a regression from paying the harbor first. `docs/FINDINGS.md` section 23 has what each found, what changed, and what holds it.

**The finding that became a contract change.** A token could spend the frame's state gas, halt it and burn the rescue's key. `vajra nominee-e2e` step 14 sends the same token at the old bytes and the new. On the old, the frame halts and the harbor holds nothing. On the new, the harbor holds the money, and the frame spent exactly 281,520 state gas, a fresh harbor and the pool closing. A control token that writes one slot works on the old bytes, so it was the state gas that did it.

**Not proven, or not finished:**

- Not run on the public devnet, with a hardware signer, or on a physical phone.
- It cannot tell the owner from a thief. A real payment left unanswered sets it off, which is a real limit and is written up in the README.
- A flood at full size was run on a mock only: 150,000 items. How long a real node takes to read that many is not measured.
- `docs/FINDINGS.md` section 23 lists what the reviews raised and was not changed.

**Mistakes on the way.** The first run of `nominee-e2e` failed at step 5 because of a race in the test. The next had one failure, in how the tool worded a revoked rescue. The first hardened run had one more, in the test: it named the owner's file `rescue.json`, the path `nominee-revoke` deletes. A rerun's phone suite failed because it ran in Chromium, and the docs name Brave or Chrome. A check in `pool-e2e` that an account ends at exactly zero was wrong: it gets its gas refund after the sweep. None of those is in the runs recorded below.

## Item 3: the better pool

Built by a parallel agent on `section-e-pool`, from `2bdbf85`, with the fixes above merged in. `section-e` was then brought to the same commit.

| Part | What it does | Does it serve the story? |
|---|---|---|
| Notes from one seed | `vajra notes-restore` rebuilds every note from the seed and the chain, on an empty machine | Yes, for a lost or wiped machine. A stolen one hands over the seed, which sits in plain text beside `daily.key`, so it does not protect against that |
| Failed payment becomes a claim | A refused payment stays in `poolHeld`, and `claim` pays it once on a new proof. This closes a flaw reproduced on the old bytes: refused money became balance a stolen daily key could spend | Yes, narrowly |
| Anonymity meter | `vajra pool`, and a card on the account page. It counts addresses, says at most, and has no top setting | The weakest fit: it keeps no money safe, and only stops people over-trusting the pool |

**Contract changes:** `unshield`, one line of `validateUnshield`, and the `noteSpent` view changed. The storage `noteSpent` became `noteState`, in the same position. `claim`, `noteState`, `Claimed` and `NothingOwed` are new. Pinned gas did not change, and no circuit changed. V2 is 23,923 bytes, up from 23,332, and the 24,576 limit does not apply on this fork: 30,000 bytes deployed on the mirror.

**Its review** read `6b32527` and found no critical or high issue: no note paid twice in any order, no way round the proof's recipient, and the rulebook held. It found the words wrong in places, and the client's fixes are in `31acd00`. The limits it raised are in `docs/FINDINGS.md` sections 24 to 26. Its fuzz of every note path is `contracts/test/NoteFuzz.t.sol`, which stubs the verifier, so it holds the accounting and not the proofs.

**Not proven:** anything on the public devnet, the meter on a large pool, or that a claim cancelling pending frames, which the sidecar's source suggests, was ever measured. `vajra shield` still refuses the hardware signer. One `pnpm -r test` stopped once with no failing test, during a `pnpm install`, and that cause was not found.

## Tests on the committed code

All of this ran on `dd98341`, the final bytes, on clean mirrors, with `forge` 1.6.0-nightly.

| Suite | Result |
|---|---|
| `pnpm test` | all pass: 240, 27, 3, 18 and 100 tests across the packages |
| `pnpm typecheck` | all seven packages pass |
| `forge test --root contracts` | 339 of 339, and `UsdcPaymasterTest` runs now |
| `vajra nominee-e2e` | 42 mined, 22 refused, 0 failures |
| `vajra pool-e2e` | 51 mined, 28 refused, 0 failures |
| `vajra e2e` | 11 mined, 22 refused, 0 failures |
| `vajra recover`, `shielded`, `exit-e2e`, `clear-sign` | 12 and 24, 12 and 30, 10 and 25, 4 and 18 mined and refused, 0 failures |
| `vajra paymaster-e2e` | 15 mined, 50 refused, canonical refused 51 of 51, 0 failures |
| `vajra sphincs-bench` | 19 mined, 54 refused, 0 failures |
| `pin`, `stealth`, `pay-e2e`, `watch-e2e`, `backup-e2e`, `move-e2e`, `proof-spam fixed`, `rep-burn fixed`, `escape-solvency fixed`, `nonce-burn v2` | passed |
| The dashboard's `nominee.mjs`, `pool.mjs`, `demo.mjs` and `flows.mjs` | 0 failures |
| `apps/phone/test/e2e.mjs`, in Brave | 0 failures |
| `apps/extension/test/e2e.mjs` | **Not run on these bytes. It fails on this machine at "Connecting takes the owner's yes": the approval window never opens. It failed the same way on `main`, so this work did not cause it.** No session here had run it before, and Brave was upgraded on 2026-11-06. The cause is not known |

## What is still open

1. Find out why the extension's approval window does not open here, or run that suite on a machine where it is known to pass.
2. The owner decides: the public redeploy, for sections 21 and 26 and the order of `escape`, and updating any hosted dashboard for the reader fix.
3. Build the exit contract for leanSphincs-S. The bench sender cannot take back its reserve, replace its key, or carry a recovery.
4. Item 4 is on hold until the owner says otherwise.

## Left running on the machine

- The mirror and `next dev` on port 3000. `make down` stops the mirror.
- Item 3's worktree, under `.claude/`, which is not in any commit. It holds the same commit as this branch. To remove it: `git worktree remove .claude/worktrees/agent-a9656fda7701e6140`.

## To run it yourself

    make judge
    alias vajra='VAJRA_STACK=local node packages/cli/src/main.ts'
    vajra sphincs-bench
    vajra nominee-e2e
    make dashboard                                   # then Your nominee in the menu
    CHROMIUM=/usr/bin/chromium node apps/dashboard/test/nominee.mjs
