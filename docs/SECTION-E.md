# Section E: where the work stands

Written on 2026-11-07, at about 01:16 IST, when the owner stopped the work in progress. It records what was done up to that point, what is proven, and what is not. Everything here is on branch `section-e`, which has not been pushed. `main` is untouched.

| Item | Status |
|---|---|
| 1. leanSphincs-S benchmark | **Done, and shown to the owner** |
| The V2 fix from item 1's review, `docs/FINDINGS.md` section 21 | **Done in the source. Not on the public devnet: that needs a redeploy** |
| A thief hiding a theft from every alert, section 22 | **Found and fixed in the client** |
| 2. Nominee | **Built and passing on the mirror. Its security review was stopped, and the owner has not been shown a final report** |
| 3. Better pool | **Not built. Stopped before any work was done** |
| 4. Shared pool across accounts | Not started |
| leanSphincs-S as the exit's key, which the owner chose | **Decided, not built** |

## Commits on `section-e`

Branched from `main` at `45c1c1b`.

| Commit | What |
|---|---|
| `be1d383` | Item 1: the benchmark, and the first write-up of the named-exit flaw |
| `4ec853b` | The V2 fix: `setExit` and `queueRecovery` |
| `69d15c4` | The queue reader fix |
| `65fabb0` | Item 2: the nominee |

## What the owner decided, on 2026-11-07

1. leanSphincs-S becomes the exit's key, and not a second master key in V2.
2. The section 21 fix goes in at the next redeploy. It is in the source. The redeploy has not happened, and only the owner decides that.
3. Start the nominee. Then start item 3 on another agent while the tests ran. The owner then stopped that agent, and the second security review.

## Item 1: leanSphincs-S

A benchmark on the local mirror: `vajra sphincs-bench`, `docs/GAS.md`, `docs/FINDINGS.md` section 20, `docs/evidence/leansphincs-gas-latest.json`. No account relies on this key, and `VajraAccountV2` did not change for it.

| | Hash key today | leanSphincs-S |
|---|---|---|
| Bytes in the signature entry | 2,337 | 4,164 |
| VERIFY gas, veto, new nonce key | 97,392 | 101,554, over the 100,000 cap |
| VERIFY gas, veto, linear nonce | not possible: each leaf needs its own nonce key | 81,544 |
| Whole transaction, veto | 172,867 | 282,298, 63% more |
| Whole transaction, escape | 490,229 | 569,962, 16% more |
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

**Proven on the mirror, on the committed code:** `vajra nominee-e2e` gave 23 mined, 17 refused, 0 failures, in 467 seconds, and it is recorded in `docs/evidence/nominee-latest.json`. It uses a real process that holds no key. In the runs so far:

- The owner answers both ways, and nothing is sent.
- Nobody answers, with a thief sending a transaction every second. The rescue landed with 12 seconds of its 15-second margin left, and 47 thief transactions were sent meanwhile. The thief got nothing.
- A theft hidden behind a dozen more, on an account short of ETH, holding tokens. The rescue lands first, and the exit pays.
- A stolen recovery paper on a frozen account. The money reaches the harbor before the thief's key tree can act.
- A rescue that would fail is reported and not sent.
- `setRoot` ends every rescue, and a new one works.

The rescue took 97,090 VERIFY gas and 489,979 for the whole transaction, with up to 0.01252 ETH held against the reserve at a 10 gwei cap. The browser test, `apps/dashboard/test/nominee.mjs`, passed with 0 failures on the committed code.

**Not proven, or not finished:**

- **It has had no security review.** The second independent review was stopped before it reported anything. So the nominee, the section 21 fix and the reader fix have all had none. The first review covered item 1 only.
- **The owner has not been shown a final report on it.**
- Not run on the public devnet, with a hardware signer, or on a physical phone.
- It cannot tell the owner from a thief. A real payment left unanswered sets it off, which is a real limit and is written up in the README.

**A mistake on the way.** The first run of `nominee-e2e` failed at step 5 because of a race in the test: it sent the owner's own escape when no thief transaction was pending, so there was nothing left to rescue. The test was fixed. The next run had one failure, in how the tool worded a revoked rescue, and that was fixed too. The run recorded above has neither.

## Item 3: the better pool

**Nothing was built.** The agent was stopped at its first step. Branch `section-e-pool` exists at `65fabb0` with no commits of its own, in the worktree `.claude/worktrees/agent-a9656fda7701e6140`.

For whoever picks this up:

- Turning a failed payment into a claim changes the existing `unshield`. The owner has been told.
- `unshield` must not revert once VERIFY has passed, and its gas is pinned: see section 13.
- V2 is at 23,332 of 24,576 bytes, so a claim path may not fit. Whether that limit applies on this fork has not been checked.
- A claim has to obey the rulebook, and a nominee's rescue has to keep working with claims outstanding.
- New findings start at section 24.

## Tests on the committed code

| Suite | Result |
|---|---|
| `pnpm test` | all pass: 173, 27, 3, 18 and 95 tests across the packages |
| `pnpm typecheck` | all seven packages pass |
| `forge test --root contracts` | **294 of 295.** `UsdcPaymasterTest` cannot set up: this machine's `forge` is 0.2.0 from 2024, and does not know `stopRecord()`, which the 2026 `forge-std` calls. Not caused by this work. So those tests did not run. Run `foundryup`, then this again |
| `vajra exit-e2e`, on the fixed V2 | 10 mined, 25 refused, 0 failures |
| `vajra recover`, on the fixed V2 | 12 mined, 24 refused, 0 failures |
| `vajra nominee-e2e` | 23 mined, 17 refused, 0 failures |
| `apps/dashboard/test/nominee.mjs` | 0 failures |

**A full rerun was in progress when this was written, and its results are not in here:** `sphincs-bench`, `e2e`, `pin`, `stealth`, `recover`, `shielded`, `exit-e2e`, `clear-sign`, `pay-e2e`, `watch-e2e`, `backup-e2e`, `move-e2e`, `paymaster-e2e`, `proof-spam fixed`, `rep-burn fixed`, `escape-solvency fixed`, `nonce-burn v2`, the dashboard's `demo.mjs` and `flows.mjs`, and the phone and extension browser tests. Treat those as not yet run on this code. That includes the new step in `watch-e2e`, which sends the hidden theft through the phone alert.

## What is still open

1. Finish the full rerun above, and commit the evidence it rewrites.
2. Get the separate security review of `4ec853b`, `69d15c4` and `65fabb0`. Your rules ask for it before merging.
3. Check two counts in the docs. `JUDGES.md` and the README say 19 mined and 53 refused for `vajra sphincs-bench`, and its step 8 has since changed, so the recorded file and those counts have to be redone.
4. Run `foundryup`, and run the contract tests again.
5. The owner decides the public redeploy, for the section 21 fix.
6. Update any hosted dashboard, for the reader fix.
7. Build the exit contract for leanSphincs-S. The bench sender cannot take back its reserve, replace its key, or carry a recovery.
8. Item 3, then item 4.

## Left running or lying around on the machine

- The full rerun, the mirror, a bridge and a `next dev` on port 3000. `make down` stops the mirror.
- The stopped agent's worktree. It is untracked, under `.claude/`, and it is not in any commit. To remove it: `git worktree remove .claude/worktrees/agent-a9656fda7701e6140`.

## To run it yourself

    make judge
    alias vajra='VAJRA_STACK=local node packages/cli/src/main.ts'
    vajra sphincs-bench
    vajra nominee-e2e
    make dashboard                                   # then Your nominee in the menu
    CHROMIUM=/usr/bin/chromium node apps/dashboard/test/nominee.mjs
