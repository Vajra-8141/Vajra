# @vajra/sdk

viem-style actions for a VAJRA account. Each action takes a client first and works on its own, or you can put them all on a client.

    import { createPublicClient, http } from "viem";
    import { vajraActions, vajraChain } from "@vajra/sdk";

    const client = createPublicClient({ chain: vajraChain, transport: http(url) }).extend(vajraActions());

    const { canonical, alt } = await client.simulate({ tx });
    const { hash } = await client.send({ tx });
    const what = await client.explain({ hash });

| Action | Takes | Gives |
|---|---|---|
| `simulate` | `{ tx, block? }` | for `canonical` and `alt`: `admitted`, `rule`, `refusal`, `reason`, `fix`, `source`, `unverified` |
| `send` | `{ tx, timeoutMs? }` | `{ hash, block, gasUsed, succeeded, receipt }`, once mined |
| `explain` | `{ hash }` | state, frames, both verdicts, and the sidecar's rule-by-rule record if it still has one |
| `spend` | `{ account, key, dailyKey, to, amount, asset?, sponsor? }` | as `send` |
| `veto` | `{ account, signer, id, sponsor? }` | as `send` |
| `escapeStatus` | `{ account }` | `{ frozen, harbor, escaped, balance }` |

`sponsor` is `{ kind: "quota", paymaster }` or `{ kind: "usdc", paymaster, usdcPerEth }`.

**Unknown is not no.** `admitted: null` and `escaped: null` mean nothing could say. Check for them: `!admitted` treats unknown as a refusal.

**What `simulate` can and cannot tell you.** The canonical verdict is ethrex's own. The sidecar has no dry run for a signed transaction, so the alt verdict replays the sidecar's rules over ethrex's real trace, and `vajra paymaster-e2e` holds each one against what the live sidecar did. That works on the mirror. On the public devnet the alt verdict is `null` beyond the prefix and structure rules, because these rules have only been checked against the mirror's sidecar. Rules that need the pool itself, such as replacement and reputation, are always listed in `unverified`.

**The network comes from the environment:** `VAJRA_STACK=local` is the mirror, and anything else is the public devnet. A client on a different chain gets `ChainMismatch`.

## Run the example

    make judge
    VAJRA_STACK=local node packages/sdk/examples/mirror.ts

It takes about 30 seconds: an account simulates, spends with the paymaster paying, has a large spend queued, vetoes it, and reads its escape status.

**Keys.** `spend` takes the daily key in this process, and `veto` takes a `MasterSigner`, which spends a one-time leaf whether or not the veto lands. Nothing here sends a key anywhere.
