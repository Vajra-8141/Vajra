# Section E: where the work stands

First written on 2026-11-07 at about 01:16 IST, when the owner stopped the work in progress. Brought up to date at about 03:00 IST, after the rerun, the second security review and its fixes. It records what is done, what is proven, and what is not. Everything here is on branch `section-e`, which has not been pushed. `main` is untouched.

| Item | Status |
|---|---|
| 1. leanSphincs-S benchmark | **Done, and shown to the owner** |
| The V2 fix from item 1's review, `docs/FINDINGS.md` section 21 | **Done in the source. Not on the public devnet: that needs a redeploy** |
| A thief hiding a theft from every alert, section 22 | **Found and fixed in the client, and two ways back in fixed after the review** |
| 2. Nominee | **Built and reviewed, with the review's fixes in and passing on the mirror. One decision is left with the owner** |
| 3. Better pool | **Being built on `section-e-pool` by a parallel agent. Not finished, not reviewed, and not in this branch** |
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
| `2dd2096` | The review's fixes to `rpc` and `readAccount` |
| `d7a7183` | The review's fixes to the rescue, the watcher and the page |
| The commit after that | Its attacks, sent for real, with the evidence and these docs |

## What the owner decided, on 2026-11-07

1. leanSphincs-S becomes the exit's key, and not a second master key in V2.
2. The section 21 fix goes in at the next redeploy. It is in the source. The redeploy has not happened, and only the owner decides that.
3. Start the nominee. Then start item 3 on another agent while the tests ran. The owner stopped that agent and the second security review when usage ran out, and both started again at about 01:23 IST.

## Item 1: leanSphincs-S

A benchmark on the local mirror: `vajra sphincs-bench`, `docs/GAS.md`, `docs/FINDINGS.md` section 20, `docs/evidence/leansphincs-gas-latest.json`. No account relies on this key, and `VajraAccountV2` did not change for it.

| | Hash key today | leanSphincs-S |
|---|---|---|
| Bytes in the signature entry | 2,337 | 4,164 |
| VERIFY gas, veto, new nonce key | 97,293 | 101,526, over the 100,000 cap |
| VERIFY gas, veto, linear nonce | not possible: each leaf needs its own nonce key | 81,529 |
| Whole transaction, veto | 172,743 | 282,298, 63% more |
| Whole transaction, escape | 490,174 | 569,962, 16% more |
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

**Proven on the mirror, on the committed code:** `vajra nominee-e2e` gave 34 mined, 21 refused, 0 failures, in 662 seconds, and it is recorded in `docs/evidence/nominee-latest.json`. It uses a real process that holds no key. In that run:

- The owner answers both ways, and nothing is sent.
- Nobody answers, with a thief sending a transaction every second. The rescue landed with 12 seconds of its 15-second margin left. A thief's transaction was in the node's pool in 23 of 46 looks, so "pending the whole time", which an earlier version of this suite said, was never true.
- A theft hidden behind a dozen more, on an account that could really pay it, holding tokens. The rescue lands first, every wei reaches the harbor, and the thief's collection dies.
- A stolen recovery paper on a frozen account. The money reaches the harbor before the thief's key tree can act.
- A rescue that would fail is reported and not sent.
- `setRoot` ends every rescue, and a new one works, and so does the real `vajra nominee-revoke`.
- A node that will not simulate, whose reads then die at the margin: it goes on the last good read. A sidecar that is down, and one that takes it and never relays it: the canonical mempool carried it with 13 and 7 seconds to spare. These three are a proxy that only withholds, in front of the real chain.
- A reserve too small: refused for free, and it lands once anyone tops it up. A reused leaf: not called rescued. A lost seed: refused.

The rescue took 97,585 VERIFY gas and 490,462 for the whole transaction, with up to 0.01252 ETH held against the reserve at a 10 gwei cap, and about 0.009 more for each token.

**The second security review** ran from 01:23 to about 01:53 IST. It found one high-severity way for a thief to stop a rescue firing, five of medium severity and six low, and that the suite's own attacks were weaker than their names. `docs/FINDINGS.md` section 23 has what it found, what changed, and what holds each one. 30 new unit tests went in, and 29 tests fail against the code before the fixes, some of them only because a helper they call did not exist yet.

**One decision is left with the owner.** A token the owner configured can take more state gas than a rescue signed for, halt the frame, and burn the leaf. Sweeping tokens after the harbor is paid would end that. It changes `escape`, an existing V2 function, so it needs the owner's word, a review and a redeploy. Until then a rescue signs for three new slots a token, which makes it less likely and does not rule it out.

**Not proven, or not finished:**

- **The fixes have not had a review of their own.** The review above looked at the code before them.
- Not run on the public devnet, with a hardware signer, or on a physical phone.
- It cannot tell the owner from a thief. A real payment left unanswered sets it off, which is a real limit and is written up in the README.
- A flood at full size was run on a mock only: 150,000 items. How long a real node takes to read that many is not measured.
- No fighting token was run on the mirror. Forge covers its execution gas, and forge has no state gas.
- `docs/FINDINGS.md` section 23 lists what the review raised and was not changed.

**Mistakes on the way.** The first run of `nominee-e2e` failed at step 5 because of a race in the test. The next had one failure, in how the tool worded a revoked rescue. The first hardened run had one more, in the test: it named the owner's file `rescue.json`, the path `nominee-revoke` deletes. The rerun's phone suite failed because it ran in Chromium, and the docs name Brave or Chrome. None of those is in the run recorded above.

## Item 3: the better pool

A parallel agent is building it on `section-e-pool`, in the worktree `.claude/worktrees/agent-a9656fda7701e6140`, from `2bdbf85`. So it does not have the fixes above yet. It has committed all three parts: notes rebuilt from one seed, the anonymity meter, and a failed payment turning into a claim. It has not reported, so nothing here is its own account of the work.

The claim changes `unshield`, and adds `claim` and `noteState` to V2. That needs its own security review before it merges, and none has been done. New findings start at section 24.

## Tests on the committed code

| Suite | Result |
|---|---|
| `pnpm test` | all pass: 206, 27, 3, 18 and 95 tests across the packages |
| `pnpm typecheck` | all seven packages pass |
| `forge test --root contracts` | **298 of 299.** `UsdcPaymasterTest` cannot set up: this machine's `forge` is 0.2.0 from 2024, and does not know `stopRecord()`, which the 2026 `forge-std` calls. Not caused by this work. So those tests did not run. Run `foundryup`, then this again. It has to be the owner: this session's permissions refused installing it |
| `vajra nominee-e2e` | 34 mined, 21 refused, 0 failures |
| `apps/dashboard/test/nominee.mjs`, `vajra watch-e2e` | 0 failures |
| `apps/phone/test/e2e.mjs`, in Brave | 0 failures |
| `apps/extension/test/e2e.mjs` | **Fails on this machine, at "Connecting takes the owner's yes": the approval window never opens. It fails the same way on `main`, so this work did not cause it.** No session here had run it before, and Brave was upgraded on 2026-11-06. The cause is not known |

Run on `2bdbf85`, before the review's fixes, on one clean mirror, all with 0 failures, and not run again since: `sphincs-bench` 19 mined and 54 refused, `e2e`, `pin`, `stealth`, `recover`, `shielded`, `exit-e2e`, `clear-sign`, `pay-e2e`, `backup-e2e`, `move-e2e`, `paymaster-e2e`, `proof-spam fixed`, `rep-burn fixed`, `escape-solvency fixed`, `nonce-burn v2`, and the dashboard's `demo.mjs` and `flows.mjs`. The fixes after that run changed `rpc`, `readAccount` and the rescue.

## What is still open

1. Get a review of the fixes in `2dd2096` and `d7a7183`.
2. Item 3: finish it, get the separate security review of its contract change, and bring in the fixes above.
3. Run `foundryup`, and run the contract tests again. Wait until item 3's agent is done: it uses this `forge`.
4. Find out why the extension's approval window does not open here, or run that suite on a machine where it is known to pass.
5. The owner decides: whether `escape` sweeps tokens last, the public redeploy for section 21, and updating any hosted dashboard for the reader fix.
6. Build the exit contract for leanSphincs-S. The bench sender cannot take back its reserve, replace its key, or carry a recovery.
7. Item 4 is on hold until the owner says otherwise.

## Left running on the machine

- The mirror and `next dev` on port 3000, and the item 3 agent's mirror on lane 1. `make down` stops the mirror, and `VAJRA_LANE=1 make down` stops the other.
- Item 3's worktree, under `.claude/`, which is not in any commit.

## To run it yourself

    make judge
    alias vajra='VAJRA_STACK=local node packages/cli/src/main.ts'
    vajra sphincs-bench
    vajra nominee-e2e
    make dashboard                                   # then Your nominee in the menu
    CHROMIUM=/usr/bin/chromium node apps/dashboard/test/nominee.mjs
