# Draft: enable the precompiles list per ERC-8421 CALLING-040

To `forshtat/mempool-workshop-sidecar`, against `2e22ff0`. Not filed.

---

**Title:** Default `precompiles` to the set ERC-8421 CALLING-040 allows

## The problem

ERC-8421 CALLING-040 allows precompiles `0x01` to `0x11` during validation. The sidecar's default is an empty list, so the code check in `validators/frameTx.ts` treats every precompile as an address with no code, and refuses it. For a payer that calls the `ecAdd` precompile:

    payer accesses un-deployed contract address 0x0000000000000000000000000000000000000006 with opcode STATICCALL

The same holds for `0x01`, so no validation frame can use `ecrecover`, and none can run a pairing check. A Groth16 verifier cannot be admitted at all. The list is already configurable through `SKANDHA_PRECOMPILES`, so this changes a default and no logic.

## The change

`packages/executor/src/config.ts`:

```diff
-  precompiles: [],
+  // ERC-8421 CALLING-040: precompiles that touch no chain state or environment,
+  // 0x01 to 0x11, and P256VERIFY.
+  precompiles: [
+    ...Array.from({ length: 0x11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`),
+    `0x${"100".padStart(40, "0")}`,
+  ],
```

The check compares against `addr.toLowerCase()`, so the entries are full-length lowercase addresses.

`0x100` is P256VERIFY. **Please check this one.** We read CALLING-040 as including it, because it touches no state. If you read the list as stopping at `0x11`, drop the second line.

## How to reproduce

The smallest payer that shows it, with no stake, in a transaction well under the 100,000 cap:

```solidity
contract PrecompileProbe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    receive() external payable {}

    function pay() external {
        (bool ok,) = address(0x06).staticcall(new bytes(128));
        require(ok);
        approve(Scope.PAYMENT);
    }
}
```

With the frames `[only_verify, pay, SENDER]`, the same bytes offered to both:

    sidecar at 2e22ff0:         payer accesses un-deployed contract address 0x0000000000000000000000000000000000000006 with opcode STATICCALL
    sidecar with this change:   admitted

From a checkout of https://github.com/Vajra-8141/Vajra:

    make judge && make unpatched
    VAJRA_STACK=local node packages/cli/src/main.ts precompile-check

## What was tested

| Check | Result |
|---|---|
| The transaction above, on both sidecars | Refused, then admitted |
| `0x06` to `0x08` in a mined VERIFY frame | Passed: a 298,084-gas Groth16 pairing check, `docs/evidence/recovery-latest.json` |
| `test/services/UserOpValidation` and `test/services/ExplorerService` | Passed, 146 of 146. This ran with the budget patch, which is a separate change |
| The sidecar's full suite and its e2e suite | **Not run** |
| Each precompile other than `0x06`, `0x07` and `0x08` admitted one by one | **Not run**. `0x01` is the only other one seen refused, on the public devnet on 2026-11-05 |

## Notes

- This does not touch the canonical mempool: ethrex decides that for itself.
- A precompile that fails burns all the gas it is forwarded, so a verifier wants to validate its input first. A proof with a point off the curve spends 63/64 of what is left.
