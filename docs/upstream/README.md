# Sidecar patch: per-entity validation budgets and precompiles

For `forshtat/mempool-workshop-sidecar` at `2e22ff0`.

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

Ran against the patched sidecar on 2026-11-06, with ethrex `9aa3645`.

| Check | Status |
|---|---|
| `git apply --check` against `2e22ff0` | **Passed** |
| Compiles as part of the sidecar | **Passed**, `bun run build` |
| The sidecar's own tests for what it touches | **Passed**, 146 of 146, `test/services/UserOpValidation` and `test/services/ExplorerService` |
| The sidecar's full test suite, and its e2e suite | **Not run** |
| Running on a node | **Passed**, in `stack/docker-compose.yml` |
| A staked sender's 400,000 VERIFY limit | **Admitted**, `vajra budget` |
| An unstaked sender over 100,000 | **Refused** |
| A VERIFY frame over 100,000 in a mined block | **Passed**, 298,084 gas, `docs/evidence/recovery-latest.json` |
| A precompile in validation | **Passed**, `0x06` to `0x08`, in that same frame |
| The same bytes refused unpatched and mined patched | **Passed**, `docs/evidence/compare-latest.json` |

[`REPRO.md`](REPRO.md) reproduces all of this in a few commands.
