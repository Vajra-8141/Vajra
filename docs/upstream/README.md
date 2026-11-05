# Sidecar patch: per-entity validation budgets and precompiles

For `forshtat/mempool-workshop-sidecar` at `2e22ff0`. Nothing here has been sent upstream.

The deployed sidecar applies a flat 100,000 cap to validation, staked or not, and refuses every precompile during
validation. ERC-8421 says otherwise on both counts: BUDGET-010 gives a staked entity 1,000,000, and CALLING-040 allows
precompiles. See `../FINDINGS.md` sections 1 and 2 for the evidence and a reproduction.

    git apply sidecar-budget-010.patch

## What it changes

- **`utils/entityBudget.ts`, new.** BUDGET-010: validation gas summed per entity, the signature cost charged to
  `tx.sender`, a `pre_verify` frame counted with the frame it precedes, and a leading `expiry_verify` frame charged to
  the sender so it cannot carry unbounded gas past the check.
- **`validators/frameTx.ts`.** Runs the check where stakes are already resolved, with "staked" meaning exactly what
  `ReputationService.checkStake` says, so it adds no on-chain reads.
- **`utils/validationPrefix.ts`.** Removes the flat execution-gas check. The state-gas cap is left alone, though the draft
  drops it.
- **`config.ts`.** Defaults `precompiles` to `0x01` to `0x11` and P256VERIFY, as CALLING-040 lists them.
- **`explorer/index.ts`, `devnet-ui/.../rules.ts`.** Reports the new rule as `BUDGET-010`.
- **Tests.** Adds `entityBudget.test.ts`, and replaces the three `validateStructuralRules` tests that asserted the flat cap.

The budgets are the draft's 100,000 and 1,000,000, not the landing page's 250,000 and 2,500,000. They are two constants.

## What has and has not been verified

| Check | Status |
|---|---|
| `entityBudget.ts` and its 14 tests | **Passed**, run on their own, outside the sidecar's test setup |
| `git apply --check` against `2e22ff0` | **Passed** |
| ethrex traces a transaction over the cap, so nothing else in `validate()` stops it | **Passed**, live: a 900,000 VERIFY limit returned a full trace with `executionStatus: success` |
| Compiles as part of the sidecar | **Not run** |
| The sidecar's own test suite | **Not run** |
| Running on a node | **Not run** |
| A VERIFY frame over 100,000 in a mined block | **Not run** |

The three "not run" rows are what to check before trusting this:

    bun install && bun run build
    cd packages/executor && npx vitest run test/services/UserOpValidation test/services/ExplorerService

Then `node packages/cli/src/main.ts budget` against a patched node should show the 400,000 limit admitted for a staked
sender and refused for an unstaked one.
