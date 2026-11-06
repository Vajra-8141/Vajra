# Draft issues for `forshtat/ethrex`

One issue per heading, to file separately. Not filed. Each was seen at `9aa3645` on the local mirror of https://github.com/Vajra-8141/Vajra unless it says otherwise. Line numbers are at that commit. Boot the mirror with `make judge`.

## `FRAMEPARAM` status halts in the prefix simulator, so a good transaction reports a failure

**What happens.** `run_frame_validation_prefix` makes a `FrameTxContext` with `frame_results: Vec::new()` (`vm.rs:3596`), and nothing in it ever pushes to that list. So `FRAMEPARAM` `0x05`, `0x0A` and `0x0B` of an earlier frame find nothing and halt with `InvalidOpcode` (`frame_tx.rs`, the `ok_or` on `frame_results.get(idx)`). Those are the reads a sponsor needs: a failed DEFAULT frame does not invalidate a transaction, so a pay frame that relies on its `pre_verify` frame has to check its status.

A transaction with frames `[only_verify, pre_verify, pay, SENDER]`, whose pay frame reads the status of frame 1, comes back from `ethrex_simulateFrameTransaction` with:

    "failedFrameIndex": 2, "haltReason": "revert", "revertData": "0x"

and is then mined, with every frame successful. The two passes disagree, and only the second is right.

**Why it matters.** The simulator's failure detail is what the sidecar reports. So a sponsor has to order its checks around this read, or its named refusals come out as `validation frame 2: reverted`. A pay frame that reverted for a real reason and one that ran out of gas then look the same.

**A fix.** Push a `FrameResult` for each frame the simulator runs, as `execute_frame_tx` does.

**Reproduce.** `contracts/src/paymasters/QuotaPaymaster.sol` reads the status in `pay`, and `vajra paymaster-e2e` mines it. Any sponsored transaction shows the fields above in `ethrex_simulateFrameTransaction`, whatever its outcome.

## `executionError` drops the revert data

When a VERIFY frame reverts in the full run, `executionError` says `VERIFY frame 2 (target 0x…, 5659 bytes of code) failed: RevertOpcode`, and the revert data is gone. The prefix simulator keeps it in `revertData`, but after the issue above that may not be the same failure. Keeping the data in the full run's error would give clients one reliable place to read it.

## The prefix simulator stops at a failed DEFAULT frame, and consensus does not

`vm.rs:3937`: "A reverted prefix frame is fatal". In `execute_frame_tx` a reverted `pre_verify` frame is not: only a reverted VERIFY frame invalidates the transaction, and the next frame runs. So a pay frame that would explain a refusal never runs in simulation. This may well be intended, since a mempool only needs a verdict. It is worth a sentence in the EIP, because it decides where a sponsor has to put its checks.

## A CALL paying a new address needs 183,600 spare execution gas in a frame

`opcode_handlers/system.rs:153` computes a state-gas spill against `state_gas_reservoir`, which is always 0 in a frame, and subtracts it from execution gas even though the state gas is charged to the frame's own pool. The gas is not spent, only required. With too little, the frame dies out of gas while reporting no state use. Seen on the public devnet on 2026-11-05. It is why our spend frames declare 500,000.

## An atomic batch keeps the status of the frames it undid

`vm.rs`, at the batch unroll: "frames that executed before the failure retain their execution status". So `FRAMEPARAM` status says success for a frame whose effects are gone. A contract that reads the status of an earlier frame to decide what happened can be misled, and ours was: `[self_verify, collect (batched), a frame that reverts, settle]` took 30.5 USDC from a paymaster's float on the mirror, before we fixed it on our side. This is what the EIP says, as the comment records. A note in the EIP, or a distinct status for an unrolled frame, would save the next sponsor from it.

## `charged >= owed` may not always hold

**Read in the source, not reproduced.** Settlement says `charged >= owed always`, and `checked_sub` turns a failure into an internal error. A frame that fails for want of state gas reports its limit, and then the entry access cost is added on top, so it can report more than its limit (`new_account_charge_failed` in `execute_frame_tx`). With no unused gas elsewhere, and an effective price equal to `max_fee`, used could pass `max_gas`. We have not built that transaction.
