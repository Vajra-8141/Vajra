# Why Arkiv

In Postgres, a second wallet vendor must trust our server to know whether a one-time key is spent; on Arkiv the safety state is
wallet-owned, publicly queryable, and reservations expire on their own.

## The problem

A WOTS key can sign once. Two signatures from one key are enough to forge a third, so a key must never sign twice, on any device,
ever. The signer's counter guards that until a backup is restored. The account's keyed nonce guards it until a signature is
revealed and never mined: the chain only learns about a key when a transaction lands.

That gap is real, and the live test shows it. `vajra arkiv` signs with key 1 and holds the transaction. A restored copy of the key
reads Arkiv and moves past key 1. The held transaction is then broadcast and **mines**, which proves the chain had no idea the key
was spent.

## What users would lose with Postgres

| With a database we run | With Arkiv |
|---|---|
| The check depends on our server being up and honest, when our server is the thing a user may have lost faith in | Any wallet reads the same data with no account with us: [a runnable query](../README.md#leaf-registry-on-arkiv) |
| A second wallet has to integrate with us, or trust a copy of our data | The query and the schema are the whole integration |
| If we shut down, the safety record goes with us, and a key restored later has nothing to check | Records outlive the company, up to the chain's 182-day limit, and can be extended |
| A reservation needs a cleanup job, and a crashed client leaves a stale lock | A reservation is an entity with a 5-minute expiry, and the chain removes it |
| Readers trust whoever runs the table | Readers trust nobody: each record carries its signature, and every reader verifies it |

The last row matters most here, and it is why the records hold the signature itself. On a public store anyone can write, so a thief
could otherwise forge "this key is spent" to stop you signing an escape. A forged record fails verification and is ignored.
This is tested live.

## What was kept off Arkiv, and why

| Kept off | Why |
|---|---|
| The master seed | Nothing about the key itself belongs anywhere but the signer |
| The harbor address and its salt | The harbor is sealed until used, so a thief cannot see where an escape will go. A public record would undo that |
| Balances, limits and the queue | They are already on the devnet, which is the source of truth. A copy could only go stale |
| Stealth payments | A record from a known wallet would link a stealth account to its owner, which is the thing stealth exists to hide |
| The rulebook | Arkiv does not enforce anything. Enforcement stays in the account, in validation |

## What this does not replace

The registry is a third layer. It does not stop a determined attacker who holds your key: it stops an honest second copy of your
key from destroying it by accident. If Arkiv cannot be reached, signing goes on under the other two layers, because an exit must
not depend on any service, this one included. [`registry.test.ts`](../packages/cli/test/registry.test.ts) proves the wallet goes on
with no answer, and that a reservation cannot stop a freeze or an escape.
