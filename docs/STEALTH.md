# VAJRA Stealth

ERC-8441 for receiving, a VAJRA account for spending, and a paymaster so the recipient never needs ETH. This is what the
alt mempool's author asked for, working on the live devnet: `node packages/cli/src/main.ts stealth`.

## What ERC-8441 gives, and what it leaves open

ERC-8441 makes announcements post-quantum: a payment secret `ss` combines ML-KEM-768 with secp256k1 ECDH, so a future
quantum attacker cannot tell from the log who was paid. It leaves spending on a plain EOA, and says so: once a quantum
computer exists, "anyone who holds a payment's `ss` can spend that payment".

Replacing that EOA with a hash-based key is the request.

## Why the obvious substitution fails

Spec §8.2 derives the spending key straight from the payment secret: `wotsSeed = keccak(ss ‖ "vajra-stealth-v1")`.

**The sender knows `ss`.** It computes it. So the sender would hold the entire spending key for the money it just paid,
and could take it back at any time, as could any scanning service, since a tracking key yields every `ss`. Spec §12 calls
this inherent to ERC-8441. It is not: ERC-8441's key is `spending_sk + H(ss)`, and the sender never learns `spending_sk`.

That protection comes from elliptic curves being additive. The sender can compute `spending_pk + H(ss)·G` from public
data, without any secret. A Merkle tree of hash chains has no such property: its root cannot be computed without the
seed, so a sender cannot derive a hash-based address that only the recipient can open.

## The design: two signatures

The account requires both, in one transaction:

| Signature | Key | Who can produce it |
|---|---|---|
| WOTS | `keccak(ss ‖ "vajra-stealth-v1")` | sender, recipient, a scanner |
| ECDSA | ERC-8441's `stealth_sk = spending_sk + H(ss)` | recipient only |

The sender can compute everything it needs to create the account, the WOTS root and the co-signer's address, from the
published meta-address and `ss`. Spending needs both keys, and they fail independently:

| Attacker | WOTS | ECDSA | Can spend |
|---|---|---|---|
| The sender, or a scanner | has it | cannot compute it | no, refused live with `CoSignerRequired` |
| A quantum attacker who is neither | no `ss`, ML-KEM holds | can forge it | no, refused live with `BadMasterSignature` |
| The sender **with** a quantum computer | has it | can forge it | **yes** |

So this is not unconditional post-quantum spending. It removes the outside quantum attacker that ERC-8441 leaves exposed,
and it keeps the classical guarantee that the sender cannot spend. What remains is a sender who also owns a quantum
computer, and a recipient can close that by moving funds on receipt.

A root the recipient alone generates would close it fully, but then the sender has no way to compute the address without
interaction. That is the open question for the ERC's authors.

## The flow

    recipient   registers a meta-address in stock ERC-6538                         registerKeys(3, meta)
    sender      ss, epk, ct, view tag exactly as ERC-8441 §2.4
                root      = key tree of keccak(ss ‖ "vajra-stealth-v1")
                coSigner  = address(spending_pk + H(ss)·G)
                account   = factory.addressOf(root, coSigner)
                deploys the clone, pays USDC, announces through stock ERC-5564     announce(3, account, epk ‖ ct, tag)
    recipient   scans: view tag, then address, exactly as ERC-8441 §2.5
    recipient   spends: [VERIFY(account), VERIFY(paymaster), SENDER(USDC.transfer)]
                signatures [ARBITRARY: WOTS, SECP256K1: co-signer], both over the signature hash

## What is unchanged and what is not

Unchanged: the meta-address, keys, `ss`, offset, view tag and announcement bytes, all checked against the ERC's conformance
vectors, and the announcer and registry, whose deployed runtime matches mainnet byte for byte (the deploy script checks).
The addresses differ, because this is a devnet.

Changed: the announced `stealthAddress` is the account, not `address(stealth_pk)`. ERC-8441 §2.4 says this argument MUST be
the derived EOA address, so a stock schemeId 3 scanner will skip these announcements. They are a variant, not conforming
schemeId 3 announcements, and may deserve their own `schemeId`.

## Departures from the spec

- **The sender deploys the account.** Spec §8.2 deploys on first spend. The live cap counts a `deploy` frame in the same
  100,000 as VERIFY and the paymaster, and it does not fit. With per-entity budgets (BUDGET-010) the factory gets its own
  budget and deploy-on-spend becomes possible. Deployment reveals nothing beyond what the payment does.
- **Linear nonce, not a keyed one.** A stealth account has no daily key to race, so leaf N is nonce N + 1, and the protocol
  still refuses a repeat. It saves the 20,000 gas a keyed nonce charges on first use, and without that the prefix would not
  fit. The cost: a leaf that was revealed but never mined cannot be skipped, only rebroadcast.
- **Stealth accounts are recognizable.** Every one is a clone of the same implementation, so an observer can tell an
  address is a VAJRA stealth account once it is deployed. They still cannot tell whose. A plain EOA does not have this
  fingerprint.
- **The paymaster is naive,** as spec §8.4 allows: it sponsors any clone of the implementation, so anyone can spend its
  balance on gas. Production takes its fee from the transfer.

## Measured

`docs/evidence/stealth-latest.json` holds the transaction. A live spend at 570 hashes used 79,274 gas in `validateMaster`,
10,089 in the paymaster and 41,352 in the USDC transfer. Declared limits are 82,000 and 15,000, which with 2,900 of
signature cost total exactly the 99,900 that fits under the cap. The client redraws any digest over 600 hashes.
