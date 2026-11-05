# Schema

Two entity types on Rabdi, chain 7,794,095. They are defined in [`packages/core/src/registry.ts`](../packages/core/src/registry.ts).

A key tree is 64 one-time keys, called leaves. `root` is the Merkle root that names the tree, and it is what the VAJRA account
stores on chain.

## `vajra-leaf-use`: a one-time key has signed

| Attribute | Type | Indexed | What it is |
|---|---|---|---|
| `root` | key | yes | Which key tree |
| `leaf` | i32 | yes | Which key in it |
| `account` | addr | no | The VAJRA account on the EIP-8141 devnet |
| `digest` | key | no | What the key signed |
| `signature` | bytes | no | 2,337 bytes: leaf, WOTS signature, Merkle path |
| `txHash` | key, optional | no | The devnet transaction. Absent if the signature was revealed and no transaction is known |
| `op` | str | no | `veto`, `freeze`, `escape` and so on, for people reading the list |
| `at` | u64 | no | Unix seconds |

- **Owner:** the wallet that published it. Ownership does not decide anything: see below.
- **Expiry:** 180 days, just under the chain's maximum of about 182.5. A tree's 64 keys are meant to be used up before that.
- **Edits:** never. A record states a fact about a signature, so it has no reason to change.
- **Queried by:** `root` and `leaf`. A signer asks for `leaf >= its counter`. The dashboard and `vajra leaves` ask for the whole tree.

## `vajra-leaf-reservation`: a key is about to sign

| Attribute | Type | Indexed | What it is |
|---|---|---|---|
| `root` | key | yes | Which key tree |
| `leaf` | i32 | yes | Which key in it |
| `account` | addr | no | The VAJRA account |
| `holder` | key | no | Random, one per copy of the key, so a copy is not stopped by its own reservation |

- **Owner:** the wallet that reserved it. Here ownership does decide: a reader only counts reservations from wallets it trusts.
- **Expiry:** 5 minutes, which covers one operation including a person reaching the button. Nobody cleans up.
- **Edits:** never. It is written, read and left to expire.
- **Queried by:** `root` and `leaf`, in the same read as the usage records.

## Why nothing is believed because of who wrote it

Anyone can write an entity with these attribute names. So a reader does not filter usage records by owner. It verifies the
signature against the root, which only the key's owner can satisfy, and ignores everything that fails. A reservation exists
before any signature does, so it cannot prove itself. It counts only from a trusted wallet, and even then it can only cost a leaf.
