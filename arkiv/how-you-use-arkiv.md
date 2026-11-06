# How VAJRA uses Arkiv

Every master operation goes through the registry. The order in [`packages/cli/src/registry.ts`](../packages/cli/src/registry.ts) and
[`wallet.ts`](../packages/cli/src/wallet.ts) is:

1. **Read** what Arkiv holds for this key tree, from the signer's own counter upward.
2. **Reserve** the leaf with an entity that expires in 5 minutes, before anything is revealed.
3. **Sign and broadcast** on the devnet.
4. **Publish** the signature as a usage record, whether or not the transaction landed, because the leaf was revealed either way.

## In the wallet app

The wallet in [`apps/wallet`](../apps/wallet) runs in a browser, so its reads and writes go through its service. Before a hash key signs, it reads the tree and checks every signature itself, then moves past any leaf the record shows as spent. It publishes the signature as soon as it exists, before the transaction is sent. A person sees this as **On Arkiv** under Proof, and as a count on the Hash key row. It skips the reservation step: that needs a separate holder for each device. If Arkiv cannot be reached, signing goes on.

## Do the filters fit?

| Query | Who runs it | Why this shape |
|---|---|---|
| `root = key(R) AND leaf >= i32(N)` | A signer, before every signature | Leaves below its own counter cannot change what it does. An up-to-date signer gets 0 rows, and a stale one gets exactly the rows it needs to see |
| `root = key(R) AND leaf >= i32(0)` | The dashboard and `vajra leaves` | The whole tree, for a person looking at it |

`root` and `leaf` are the only indexed attributes, because they are the only ones filtered on. `account` was indexed at first and
the index was removed: nothing queried it, and a query by account would be unsafe to show, because anyone can write valid signatures
from a tree of their own and claim your account.

A signer's read returns 0 rows in steady state, measured by step 3 of `vajra arkiv`.

## Do the edit permissions fit?

Neither entity is ever edited, so ownership never has to grant anything. What it does is separate the two kinds of trust:

- **Usage records ignore ownership entirely.** The signature proves the record. A reader that trusts no writer verified every
  genuine use in the live test, and rejected a forged one.
- **Reservations depend on ownership.** One written before any signature exists cannot prove itself, so it counts only from a wallet
  the reader trusts, set by `ARKIV_WRITERS`. A stranger's reservation is ignored, also tested live.

## Does expiry fit?

Yes, and it is the reason reservations are entities rather than rows in a lock table.

- **Reservations, 5 minutes:** long enough for a person to reach the button. If a device crashes mid-operation, the lock removes
  itself. `vajra arkiv` reserves for 20 seconds and watches the entity disappear with nobody cleaning up.
- **Usage records, 180 days:** just under the chain's limit. A tree of 64 leaves is meant to be used up well within that. A record has
  to outlive the period in which a stale backup might be restored.

## Does each feature change what users see?

| Feature | What the user sees |
|---|---|
| Key panel on the dashboard | The next key, and each used key with its operation, time and links. Each row says "signature verified" because this browser just checked it |
| A copy of the key that is behind | A red warning naming the key. A software signer moves past it, logging why. The hardware signer refuses with `LeafUsedElsewhere` |
| Another copy holding a key | An amber warning. A software signer moves to the next key. The hardware signer refuses an ordinary operation with `LeafReservedElsewhere`, and freeze and escape go ahead regardless |
| A forged record | A line saying how many records were ignored, so an attempt is visible rather than silent |
| Arkiv unreachable | A plain notice that signing still works without it |
| The private route | The page asks before reading, and says what a direct read reveals |

## Limits

- A write that fails is reported and not retried, so a record can be missing. The other two layers still stand.
- A reader pages through at most 500 rows of each type. A snapshot says so if it stopped early, so a flood of forged records can
  hide a real one, and it costs the attacker a write for each.
- Reads and writes from the CLI and the bridge go direct, so Arkiv's RPC sees that machine's IP address, as the mempool does when a
  transaction is sent.
