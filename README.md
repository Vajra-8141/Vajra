# VAJRA

**An Ethereum account that behaves like a bank account, whose master key is made of hashes instead of curves.**

Spending limits, withdrawals you can cancel, a panic button. Your wallet stays your everyday key, with bounded powers. A
Winternitz one-time key outranks it, so a stolen seed phrase cannot empty the account, and the key that matters has no
curve for a quantum computer to break.

If your seed phrase is stolen, a thief can take a day's limit and no more. Anything bigger waits in public, where you can
cancel it. And when you press escape, the thief cannot stop you.

Built on [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions and the ERC-8421 alternative mempool.
Everything below runs on the public devnet (chain 1337).

## Why this needs the alternative mempool

**A thief with your daily key can block your escape on the public mempool.** The canonical mempool will not hold a keyed
transaction next to a pending linear one from the same sender, and the thief can always keep one pending, because the
thief has the key. The alternative mempool keeps the two independent. Run live three times, with the thief's transaction
pending and the same signed escape offered to both:

    canonical:  A frame transaction in the other nonce-key domain is already pending for this sender
    alt:        admitted, mined, all frames succeeded

Reproduce it: `node packages/cli/src/main.ts pin`. The limit, stated first: this lasts while a thief transaction is
pending, which on this idle devnet means sending one every slot, and with none pending the canonical mempool takes the
escape too.

**What this is not:** a claim that post-quantum signatures are too expensive for the public mempool. We expected that and
measured otherwise. At w=16 a full WOTS verification fits under the 100,000-gas cap:

| Master key | Signature | VERIFY gas (median) | Live alt mempool |
|---|---|---|---|
| **WOTS w=16** | 2,144 B | **90,009** | **admitted and mined** |
| WOTS w=256 | 1,120 B | 334,362 | refused |

w=256 is refused even with a stake, because the deployed sidecar has not implemented ERC-8421's 1,000,000-gas staked
budget. [`docs/FINDINGS.md`](docs/FINDINGS.md) has the evidence, and [`docs/upstream/`](docs/upstream/) has a patch.

## What works

Status follows the ledger in the spec: a module is BUILT only if it runs on the live devnet.

| Module | Status | Evidence |
|---|---|---|
| WOTS verifier and key tree | BUILT | Solidity checked against an independent TypeScript implementation |
| Dual-path account | BUILT | master and daily paths, both mined |
| Daily limit, new-payee cooling, public queue, veto | BUILT | `vajra e2e` |
| Freeze, escape, sealed harbor | BUILT | `vajra e2e` |
| Key rotation | BUILT | `vajra e2e` |
| Stock wallets as the daily key | BUILT | personal_sign path mined; exercised with a scripted wallet, not the MetaMask extension |
| ERC-8441 stealth, co-signed spend, paymaster | BUILT | `vajra stealth`, passes the ERC's conformance vectors |
| Dashboard, exposure scanner | BUILT | every flow driven in a real browser over the Nym mixnet, with a scripted wallet |
| Master key on hardware | NOT STARTED | the signer is software on this machine, behind the interface a device will use |
| Nominee | NOT STARTED | |
| STARK recovery | DESIGNED | spec §9; **no proof exists** |
| Shielded notes | DESIGNED | spec §10; **no hidden balances exist** |

**The privacy boundary:** dashboard reads are private and the harbor is sealed until used. Balances, rules and the queue are
public on chain, and sending a transaction shows your IP to the mempool. Hidden balances are not built.

## Tested attacks

All tried for real against the live devnet by `vajra e2e` and `vajra stealth`. Each dies in validation, before it can
cost the account anything, with the named refusal shown.

| Attack | Refusal |
|---|---|
| Stolen daily key calls escape, rotates the tree, raises its limit, replaces itself, vetoes | `EscapeKeyOutranks` |
| Stolen daily key changes the harbor | `HarborImmutable` |
| Stolen daily key adds a second frame paying the thief directly | `FrameNotAllowed` |
| Stolen daily key burns the balance through fees, or splits approval across two frames to dodge the cap | `DailyTxCostExceeded` |
| Any old signature from the daily key, for any message | `SignatureNotBoundToTransaction` |
| A wallet signature moved onto a different recipient | `SignatureNotBoundToTransaction` |
| Daily key spends while frozen, or after an escape | `AccountFrozen` |
| A one-time key signs twice, through a compromised signer | protocol nonce, then `LeafAlreadySpent` |
| The stealth sender takes the money back, holding the full hash key | `CoSignerRequired` |
| An attacker with the ECDSA key but not the hash key | `BadMasterSignature` |

A spend over the limit is not refused: it queues, in public, and the master key can cancel it. A hostile token cannot block
an escape: malformed returns, return bombs and gas burners are all tested.

## Run it

Needs Node 22.18 or newer, pnpm and Foundry.

    git submodule update --init
    pnpm install
    pnpm test && pnpm test:contracts

The contracts are already on the devnet, at the addresses in `packages/core/src/deployments/1337.json`.

    alias vajra='node packages/cli/src/main.ts'
    vajra create --harbor 0xYourSafeAddress     # needs a funded .vajra/deployer.key
    vajra status
    vajra spend 0xRecipient 0.0001
    vajra freeze

Or with the dashboard, where your wallet is the daily key:

    vajra bridge                                # holds the master key, in its own terminal
    pnpm --filter @vajra/dashboard dev          # http://localhost:3000

The tests that run against the devnet, and write to it:

    vajra e2e        # the account, and every attack
    vajra stealth    # a stealth payment, and who cannot spend it
    vajra pin        # the blocked escape
    vajra budget     # the validation cap
    vajra measure    # the gas table

## How it fits together

    packages/core       WOTS, frame transactions, stealth payments, exposure. Runs in a browser and in Node.
    packages/cli        the wallet, the bridge, and the live test runs
    apps/dashboard      Next.js: account, exposure scanner, proof page
    contracts           VajraAccount, Wots, VajraFactory, SponsorPaymaster
    docs                measured gas, devnet findings, stealth design, demo runbook, upstream patch

The rulebook runs in the SENDER frame, because `TIMESTAMP` is banned in validation in every mempool. VERIFY enforces who may
act and what shape the transaction has. That is what makes the priority rule structural: a daily-signed transaction that
reaches a master function never becomes valid.

## CROPS

- **Censorship resistance:** the escape reaches the chain even while a thief holds the public mempool slot, and it needs
  nothing from us. Any ERC-8421 node can carry it.
- **Open source:** every line is here. Contracts, client, tests.
- **Privacy:** dashboard reads go through [anon-rpc](https://github.com/ethereum/anon-rpc), over the Nym mixnet by default. If
  the route fails, the dashboard stops rather than falling back to a direct connection. Transactions do not use it: the sidecar
  refuses requests that arrive through the Nym worker, so they go straight to the mempool, and the page says so before you
  sign. The CLI and the bridge connect directly, because anon-rpc is browser-only today. No analytics, no trackers.
- **Security:** a hash-based master key that the daily key cannot override, with the priority enforced in validation.

## What this does not prove

1. **This is not production post-quantum cryptography.** The parameters are unreviewed and there is no formal proof. Plain
   keccak chains give multi-target attacks a discount of about 19 bits that WOTS+ or XMSS would remove. Production means
   LMS, XMSS or SPHINCS+, which are heavier.
2. **Stealth spending has a remaining case.** A sender who also owns a quantum computer can spend what it sent. See
   [`docs/STEALTH.md`](docs/STEALTH.md).
3. **The master key is a software signer.** Its seed sits in a file. The bridge signs what the dashboard asks for and shows no
   confirmation, which a device would.
4. **The rulebook does not bound gas across transactions.** A thief can burn the account's ETH through many transactions,
   each under the per-transaction cost cap. That leaves through fees, not the daily limit.
5. **A 64-leaf tree is a demo lifetime.** Rotation works. Backing up one-time key state across devices is the known unsolved
   problem of stateful hash signatures.
6. **Devnet only.** Chain 1337 can reset at any time, and the explorer keeps its history in memory. Recorded evidence is in
   [`docs/evidence/`](docs/evidence/).
7. **Quantum timelines are uncertain.** The claim is not that Q-day is close. It is that migration rails have to exist first.
