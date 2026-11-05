# How AI was used

Claude Code wrote most of the code in this repository from the team's specification, `04-VAJRA-FULL-SPEC.md`, and ran it
against the live devnet. The team set the direction and made the decisions, including the ones that changed the project's
pitch once the measurements came in.

Commits carry no tool attribution, by the team's rule, so this file is where that is recorded.

## What was checked, and how

AI-written code was not taken on trust. Where a claim mattered, it was tested against something independent of the code
that made it:

- The Solidity verifier is checked against signatures from a separate TypeScript implementation.
- The ERC-8441 implementation is checked against the ERC's own conformance vectors.
- Every rule and refusal in the README was exercised on the live devnet, and the measured numbers come from the real client.
- The dashboard was driven in a real browser.

## Where testing changed the design

- The leaf registry's first design would have let a thief block an escape by forging "this key is spent", because anyone can write to
  Arkiv. Records now carry the signature, and every reader verifies it.
- The dashboard's key panel raised a false "your key is behind" warning after every operation. The browser test found it.
- Arkiv reads could not go over the Nym route. Falling back quietly would have broken a stated privacy promise, so the page asks.

These came from running the code rather than from reasoning about it, and each overturned something in the original plan:

- The alt mempool refuses more than 100,000 gas of validation even for a staked sender, so the plan to rely on that budget
  had to change. See `docs/FINDINGS.md`.
- The sidecar refuses all precompiles during validation, so the first design for wallet signatures, using `ecrecover`, had
  to be replaced.
- The original stealth derivation let the sender spend what it paid. See `docs/STEALTH.md`.
- A review of the account's own validation found that splitting approval across two frames skipped the fee cap. It was
  confirmed as exploitable on the previous deployment, fixed, and added to the live attack suite.
