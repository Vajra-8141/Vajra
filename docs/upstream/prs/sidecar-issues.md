# Draft issues for `forshtat/mempool-workshop-sidecar`

One issue per heading, to file separately. Not filed. Each was seen at `2e22ff0` on the local mirror of https://github.com/Vajra-8141/Vajra unless it says otherwise. Boot it with `make judge`, and the second sidecar with `make unpatched`.

## The flat validation cap, and a patch

Covered by `docs/upstream/sidecar-budget-010.patch`, with its own README: BUDGET-010 per entity, in place of one 100,000 cap for the whole prefix. Seen on the public devnet: a staked sender's 400,000 limit refused. With the patch, a 298,084-gas VERIFY frame mined.

## There is no dry run for a signed transaction

`eth_estimateFrameTransactionGas` replaces every body frame's limits with 10,000,000 before validating. Those limits are in the signature hash, so any transaction carrying a real signature fails:

    Invalid frame transaction signature

So no client can ask "would you admit this?" without sending it. A wallet wants exactly that before it spends a one-time key.

**A request.** A method that runs `FrameTxValidationService.validate` on the transaction as given, and returns the `CheckCollector` result, with no mempool insert. The explorer already has the shape: `AdmissionRecord.checks`.

We replay the rules over ethrex's trace in the meantime (`packages/core/src/admission.ts`), and we would rather delete that.

## A replay can be refused for the wrong reason

When ethrex returns no trace, `validate` builds its message from `canonicalMempoolViolation` first. That field holds the first *canonical* violation, which is not a rule of this mempool. A mined transaction with a prefix over 100,000, replayed byte for byte:

    prefix gas budget exceeded: 262800 > 100000 (MAX_VERIFY_GAS)

on a sidecar where that same prefix was admitted a moment earlier. The real cause, the nonce, is in `executionError`. It does get refused, so this costs nothing but time, and the fix is to prefer `executionError` here. A prefix under 100,000 gets the right text, `Nonce mismatch: expected 3, got 2`, because no canonical budget violation comes first.

## Smaller things

- **`bundleInterval` is in milliseconds.** A value of 2 starves the reconciler: mined transactions stay `Submitted`, keep counting against the sender's balance, and new ones get `cannot cover its pending frame transactions`.
- **`SELFBALANCE` in validation needs a stake strictly above the minimum.** `frameTx.ts` compares with `>`, and `checkStake` with `<`, so an entity at exactly the minimum is staked and still cannot use it.
- **`/rpc` answers HTTP 415 to a request with no usable content type.** Over a Nym worker the header is lost, so the sidecar cannot be reached that way. Seen on the public devnet. Where exactly the header goes was not traced.
- **A gateway can hold a transaction the miner never sees.** Seen on the public devnet: a transaction sat in the gateway's mempool while the miner never saw it. Not traced further.
