# VAJRA

**An Ethereum account that behaves like a bank account, whose master key is made of hashes instead of curves.**

Spending limits, withdrawals you can cancel, a panic button. Your wallet stays your everyday key, with bounded powers. A
Winternitz one-time key outranks it, so a stolen seed phrase cannot empty the account, and the key that matters has no
curve for a quantum computer to break.

If your seed phrase is stolen, a thief can take a day's limit and no more. Anything bigger waits in public, where you can
cancel it. And when you press escape, a thief's pending transaction cannot stop you.

> **Two flaws we found in our own contract, now fixed on chain.** A thief holding only the daily key could spend every nonce key the master key
> needs, which ended the master key. And whoever paid a stealth account could take the money back with no co-signature. Independent reviews found both,
> and we reproduced both on the local mirror: 64 of 64 leaves burned, 25 of 25 tokens taken. Each fix is one check. The public devnet was reset on
> 2026-11-06, and what is deployed there now has them. The bytes first deployed are kept, so `vajra nonce-burn` and `vajra stealth-theft` still show the attacks.
> See [`docs/FINDINGS.md`](docs/FINDINGS.md) sections 8 and 9.

Built on [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions and the ERC-8421 alternative mempool.
The core runs on the public devnet (chain 1337). Recovery by proof and the shielded pool run on a local mirror of it, because the
deployed sidecar cannot admit them. **To run all of it yourself, see [`JUDGES.md`](JUDGES.md): one command.**

A transaction admitted by the alt mempool and mined, on the chain as it stands since the reset:
[`0xc80c…fecb`](https://explorer.altmempool.wtf/tx/0xc80cb5dfdd9778f05c992bb1d90365204599bbd9ce830d44ddba8dae503bfecb). The explorer keeps its history in memory, so the record that lasts is in [`docs/evidence/`](docs/evidence/).

**About the evidence.** The devnet was reset on 2026-11-06, which wiped every earlier transaction. `vajra e2e`, `vajra pin` and `vajra stealth` have been rerun on the new chain, genesis `0x2ad3f67b…`, on the fixed contracts.
The hardware, dashboard and Arkiv records in `docs/evidence/` were captured before the reset, so their transactions can no longer be looked up.

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

Status follows the ledger in the spec: a module is BUILT only if it runs on the live devnet. BUILT, LOCAL means it runs, with recorded
evidence, on the local mirror and nowhere else.

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
| Master key on hardware | BUILT | a real ESP32 signed through the CLI (7 mined) and the dashboard (3 mined), with a person pressing BOOT. **Not safe from a computer it is plugged into**: see [`docs/HARDWARE.md`](docs/HARDWARE.md) |
| Leaf registry on Arkiv | BUILT | `vajra arkiv`, on the live Arkiv testnet and devnet. The dashboard reads it and verifies each signature in the browser |
| Phone alert, "Not me" and "Pay, it's me" | IN BUILD | `vajra watch`. Runs end to end on the mirror against a local stand-in for Telegram's servers. Also tried on Nov 6 with a real bot and phone on the mirror: two **Not me** taps cancelled, one **Pay, it's me** tap paid 0.5 ETH, using the software signer. **Not me** also passed on the public devnet with real MetaMask and a real phone. **Pay** has not been tried there, or with the board signing |
| Browser extension | BUILT, LOCAL | `apps/extension/test/e2e.mjs`: loaded in Brave, a dapp connected over EIP-1193 and EIP-6963, and paid, on the mirror. Pays only: see below |
| Phone app | BUILT, LOCAL | `apps/phone/test/e2e.mjs`: the PWA in Brave against the real service. Not tried on a physical phone |
| Web Push, self-hosted VAPID | BUILT, LOCAL | `apps/phone/test/real-push.mjs`: a theft on the mirror, through Google's real push service, to a notification in a real service worker |
| Address book and first-seen warnings | BUILT, LOCAL | in the extension, the phone and `packages/shared` |
| Encrypted backup, and a restore that proves itself | BUILT, LOCAL | `vajra backup-e2e`: root match, stale leaves refused |
| One-transaction move from an EOA | BUILT, LOCAL | `vajra move-e2e`, and from the extension's move page |
| Passkey before **Pay, it's me** | BUILT, LOCAL | Client-side only: the phone and the local service check it, and **the contracts do not know about it** |
| Nominee | NOT STARTED | |
| Recovery by proof, Groth16 v1 | BUILT, LOCAL | `vajra recover`: 8 mined, 21 refused, 0 failures. **Not post-quantum**: see below |
| Shielded pool, fixed denomination v1 | BUILT, LOCAL | `vajra shielded`: 12 mined, 24 refused, 0 failures. **Does not hide that the account paid the recipient**: see below |
| STARK recovery and shielded v2 | DESIGNED | spec §9, §10; **no STARK proof exists** |
| Variable amounts, note-to-note transfers, viewing keys, ERC-8441 note delivery | DESIGNED | spec §10; **not built** |

**The privacy boundary:** dashboard reads are private and the harbor is sealed until used. Balances, rules and the queue are
public on chain, and sending a transaction shows your IP to the mempool. The shielded pool is local only, and hides which deposit
paid a withdrawal, not that the account paid the recipient. The leaf registry is the
exception to private reads: Arkiv refuses requests from the Nym route, so the dashboard asks before reading it directly, and the
bridge connects to Arkiv directly, which shows it your IP and key tree.

## Recovery by proof, and a shielded pool that obeys the rulebook

**Recovery:** lose the master key, and a Groth16 proof of a secret you keep offline queues a new key tree. It goes through the same
public queue as a large spend, so the master key can veto it if the paper was stolen, and the new tree signs once the delay passes.

**The pool:** fixed-size notes inside the account, spent with a proof and no key. **The rulebook survives inside the shielded world:** a
freeze blocks an unshield in validation, an escape drains the pool to the sealed harbor, and the daily key cannot reach it at all.

Both need more validation gas than the flat 100,000 cap, and pairing precompiles, so neither can run on the deployed sidecar. One
transaction, byte for byte, from a staked account (`vajra compare`, in `docs/evidence/compare-latest.json`):

    sidecar as deployed:     500000 ... exceeds MAX_VERIFY_GAS 100000
    canonical mempool:       Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS
    sidecar with the patch:  mined, VERIFY 298,084 gas

So they run on a local mirror: the same ethrex and sidecar commits, with [one patch](docs/upstream/). The EF's rulings, in writing: "a local
sidecar is fine for judging", and on the budgets, "no science behind any of the gas limits". **The allowlist restores the spec's own
behavior:** CALLING-040 already allows precompiles `0x01` to `0x11`, and BUDGET-010 already gives a staked entity 1,000,000.

Say these before anyone asks. [`docs/ZK.md`](docs/ZK.md) has the rest.

- **Groth16 is not post-quantum.** It rests on pairings. The recovery path is weaker against a quantum computer than the key it replaces.
  v2 is a STARK verified in the account, per EF guidance, and it is not built.
- **The trusted setup has one contributor, us.** Whoever ran it could have forged proofs.
- **The anonymity set starts tiny.** It is one account's pool.
- **The chain still shows that this account paid that recipient.** The pool hides which deposit paid. An outside depositor gets real, small
  unlinkability, and an owner shielding their own balance gets almost none. That is the cost of a pool the rulebook can govern.
- **Lost master key plus stolen paper means the thief wins.** The veto needs a master key.
- **Nothing here is audited.** Two independent reviews found three critical bugs, each reproduced on a real client and fixed in the source.
  Two of them are the flaws at the top of this page.

## A phone alert for anything queued

A theft has to wait in the public queue, so an account can warn you. `vajra watch` asks you on Telegram: **"0.5 ETH to 0x72A9…2C49. Was this you?"**

- **Not me** cancels it, signed by the hash key.
- **Pay, it's me** sends it now, signed by the hash key. It is one transaction that cancels the item and sends the same payment, as an atomic batch, so if the item was executed first, nothing pays twice.

The phone can ask, and only the master key can act. With the hardware signer, a tap still needs a press on the device. On a software signer a tap would be enough to move money, so Pay is off unless you turn it on. The laptop only makes outbound
connections, so the bridge stays on loopback. Telegram sees what the alerts say, so this is off unless you set it up. The dashboard raises the same alarm, in the browser, from the same queue.

**Limits:** a spend under the daily limit leaves at once, so the alert cannot stop it. An attack refused in validation never reaches the queue. The watcher has to be running.

## Extension, phone app, backup and move

These run on the local mirror. See [`JUDGES.md`](JUDGES.md) for the commands.

**Extension** (`apps/extension`). A dapp connects to the VAJRA account, and the key behind it is the daily key, sealed with your password. The master key is never in it. It can pay ETH and ERC-20 transfers, because `spend` is all the daily key can do. Any other contract call is refused, and so is `personal_sign`: the account has no ERC-1271, so a daily-key signature would prove nothing. So a dapp that needs a login signature or a swap will not work with it.

**Phone app** (`apps/phone`, served by `vajra phone`). Each queued item gets a decoded review: amount, payee, why it queued, what is odd about it, with **Not me** and **Pay, it's me**. Taps pass the same `decide` as Telegram, including the rule that Pay needs the hardware signer unless `--allow-software-pay`. The phone holds a pairing token and a passkey, and never the master key. Push messages are encrypted to the phone, so the push service sees ciphertext. Telegram stays as the backup, and can run beside it: a lock across processes stops the two from taking the same leaf.

**Limits of the phone app.** The service listens on loopback, and a PWA needs a secure origin. A real Android phone should reach it with `adb reverse tcp:3210 tcp:3210`, which has not been tried. Brave needs "Use Google services for push messaging" turned on, and the first subscribe took a few minutes.

**The passkey is a client-side check.** The phone asks for it and the local service verifies it. No contract changed, and a master signature made any other way does not need it.

**Backup.** `vajra backup` encrypts the signer and its one-time key state with scrypt and AES-256-GCM. `vajra restore` recomputes the root from the seed, compares it with the chain, reads every leaf's nonce from the chain, and refuses a state that has forgotten a spent leaf. **What it cannot see:** a signature revealed and never mined, unless the leaf registry is on. After using a stale backup with `--advance-past-chain`, rotate.

**Move.** `vajra move` sends one frame transaction from an EOA, which creates the account and moves the ETH and listed tokens. The frames are an atomic batch, so a failed transfer means no account and no money moved. The EOA stays on as the daily key. The refund of unused gas lands after the last frame, so a few millionths of an ETH stay behind. A stock wallet cannot sign a frame transaction, so this asks for the private key: from a file in the CLI, and in the extension's page, where it goes no further than the extension.

## Leaf registry on Arkiv

A one-time key must never sign twice, on any device. The signer's counter fails when a backup is restored, and the chain's nonce only
moves when a transaction is mined, so a signature that was revealed and never mined is invisible to it. Every master operation now
reads a public registry on [Arkiv](https://arkiv.network) before signing, reserves the key with an entity that expires in 5
minutes, and publishes the signature afterwards.

Anyone can write to Arkiv, so nothing is believed because of who wrote it. **Each record carries the signature itself, and every
reader verifies it**, so a thief cannot forge "this key is spent" to block an escape. If Arkiv is unreachable, signing goes on: the way
out must not depend on it.

**Writer wallet:** `0x8108ac6F8eb2945E11938176b7c3EdfC17fF478c`, on Rabdi, chain 7,794,095. `vajra arkiv` also funds a throwaway wallet
on each run to write the forged entities it tests against.

**Run a query.** This needs nothing installed and no key, and returns every use of one key tree:

    curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str(\u0027vajra-leaf-use\u0027) AND root = key(0xced04393930ba48b36d6e92db07d8b9996e102823f2d303b9c5d7384d139a2fa)",{"select":{"key":true,"attributes":{"leaf":true,"op":true,"txHash":true}},"limit":"0x64"}]}'

The public endpoint has a small shared budget, so this can answer `ANON_COST_LIMITED`. A free key from
[hub.arkiv.network](https://hub.arkiv.network) goes on the end of the URL. To verify the signatures as well:

    node packages/cli/src/main.ts leaves 0xced04393930ba48b36d6e92db07d8b9996e102823f2d303b9c5d7384d139a2fa

Design and judging answers are in [`arkiv/`](arkiv/): [schema](arkiv/schema.md), [why Arkiv](arkiv/why-arkiv.md),
[how it is used](arkiv/how-you-use-arkiv.md), [reach](arkiv/reach.md), [friction](arkiv/friction.md).

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
| The stealth sender takes the money back, holding the full hash key, on either kind of nonce | `CoSignerRequired`. Fixed: the contract first deployed let a keyed nonce through |
| Stolen daily key spends the master key's nonce keys | `DailyNonceKeyInvalid`. Fixed: the contract first deployed let this through |
| An attacker with the ECDSA key but not the hash key | `BadMasterSignature` |

A spend over the limit is not refused: it queues, in public, and the master key can cancel it. A hostile token cannot block
an escape: malformed returns, return bombs and gas burners are all tested.

On the local mirror, by `vajra recover` and `vajra shielded`, each sent for real:

| Attack | Refusal |
|---|---|
| Anyone sends a corrupted proof, or one from the wrong secret, account, chain or epoch | `RecoveryProofInvalid`, `ShieldProofInvalid` |
| A proof seen in a mempool, moved to the attacker's root or address | `RecoveryProofInvalid`, `ShieldProofInvalid` |
| A proof seen in a mempool, resent with a frame paying the attacker, or too little gas so that it dies, or on another nonce key | `ProofTxShapeInvalid` |
| A proof seen in a mempool, resent with a huge fee to burn the balance | `ProofTxCostExceeded` |
| A spent nullifier, for a recovery or a note | `NullifierSpent` |
| A stolen recovery paper | queues in public, then `RecoveryVetoed` |
| Daily key tries recovery, the pool, or the master key's nonce keys | `EscapeKeyOutranks`, `FrameNotAllowed`, `DailyNonceKeyInvalid` |
| A note in a tree of the attacker's own, or a root that left the window | `RootUnknown`. For an honest note this is a tier, not an error: prove again |
| A valid proof while frozen, or after an escape | `AccountFrozen` |
| An old note, against money that arrived after the escape | `ValueNotConserved` |
| An outsider opens a pool on someone else's account | `PoolClosed` |

## Run it

Needs Node 22.18 or newer, pnpm and Foundry.

    git submodule update --init
    pnpm install
    pnpm test && pnpm test:contracts && pnpm test:firmware

The contracts are already on the devnet, at the addresses in `packages/core/src/deployments/1337.json`.

    alias vajra='node packages/cli/src/main.ts'
    vajra create --harbor 0xYourSafeAddress     # needs a funded .vajra/deployer.key
    vajra status
    vajra spend 0xRecipient 0.0001
    vajra freeze

Or with the dashboard, where your wallet is the daily key:

    vajra bridge                                # holds the master key, in its own terminal
    pnpm --filter @vajra/dashboard dev          # http://localhost:3000

The leaf registry is optional. To turn it on, put a free access key and a wallet holding tGLM, both from
[hub.arkiv.network](https://hub.arkiv.network), in `.env`:

    ARKIV=your-access-key
    DEV_WALLET_PRIVATE_KEY=your-testnet-key

To run everything locally instead, including recovery and the pool, see [`JUDGES.md`](JUDGES.md).

The tests that run against the devnet, and write to it:

    vajra e2e        # the account, and every attack
    vajra arkiv      # two copies of one key, on Arkiv and the devnet
    vajra stealth    # a stealth payment, and who cannot spend it
    vajra pin        # the blocked escape
    vajra budget     # the validation cap
    vajra measure    # the gas table

## How it fits together

    packages/core       WOTS, frame transactions, stealth payments, exposure. Runs in a browser and in Node.
    packages/cli        the wallet, the bridge, and the live test runs
    apps/dashboard      Next.js: account, exposure scanner, proof page
    firmware            the ESP32 signer, and its logic as a portable library
    contracts           VajraAccount (deployed), VajraAccountV2 (local), Wots, VajraFactory, SponsorPaymaster, generated verifiers
    circuits            the two Groth16 circuits, their keys, and the build
    stack               the local mirror: Compose, genesis, block producer
    docs                measured gas, devnet findings, proofs, stealth design, demo runbook, upstream patch
    arkiv               how the leaf registry uses Arkiv, and the judging answers

The rulebook runs in the SENDER frame, because `TIMESTAMP` is banned in validation in every mempool. VERIFY enforces who may
act and what shape the transaction has. That is what makes the priority rule structural: a daily-signed transaction that
reaches a master function never becomes valid.

## Against the judging criteria

**Creativity:** a bank account's rules, enforced in validation, with a hash-based key outranking the wallet you already use, and a shielded pool that a freeze can stop and an
escape can sweep. **Usefulness:** a stolen seed phrase costs a day's limit instead of everything, and a lost master key is recoverable. **Practicality:** your wallet stays your
wallet, verification fits under the 100,000 cap at w=16, and `make judge` runs all of it. **How well it works:** every claim here has a command and a recorded run, and the flaws we
found are at the top of this page. **Relation to the alt mempool:** it carries the escape past a thief's pending transaction, and it is the only route for a proof that needs a
staked budget and precompiles.

## CROPS

- **Censorship resistance:** the escape reaches the chain even while a thief holds the public mempool slot, and it needs
  nothing from us. Any ERC-8421 node can carry it.
- **Open source:** every line is here. Contracts, client, tests.
- **Privacy:** dashboard reads go through [anon-rpc](https://github.com/ethereum/anon-rpc), over the Nym mixnet by default. If
  the route fails, the dashboard stops rather than falling back to a direct connection. Transactions do not use it: the sidecar
  refuses requests that arrive through the Nym worker, so they go straight to the mempool, and the page says so before you
  sign. Arkiv refuses them too, so the page asks before reading it directly. The CLI and the bridge connect directly, because
  anon-rpc is browser-only today. No analytics, no trackers.
- **Security:** a hash-based master key that the daily key cannot override, with the priority enforced in validation.

## What this does not prove

0. **Two reviews found critical bugs after every test passed.** They are fixed, but nothing says they were the last. This has not been audited.
1. **This is not production post-quantum cryptography.** The parameters are unreviewed and there is no formal proof. Plain
   keccak chains give multi-target attacks a discount of about 19 bits that WOTS+ or XMSS would remove. Production means
   LMS, XMSS or SPHINCS+, which are heavier.
2. **Stealth spending has a remaining case, even with the fix.** A sender who also owns a quantum computer can spend what it sent. See
   [`docs/STEALTH.md`](docs/STEALTH.md).
3. **By default the master key is a software signer, on the same machine as the wallet.** Its seed sits in a file, so a
   phished seed phrase cannot reach it, but malware on that machine gets both keys and the rulebook protects nothing. The two
   keys only outrank each other if they live apart, which is what the hardware signer is for, but on this board that only holds
   while it is unplugged. Any program on a computer it is plugged into can copy the key in half a second and press its button,
   both measured in [`docs/HARDWARE.md`](docs/HARDWARE.md). It is a prototype, not a secure element, and it has no PIN.
4. **The rulebook does not bound gas across transactions.** A thief can burn the account's ETH through many transactions,
   each under the per-transaction cost cap. That leaves through fees, not the daily limit. With no ETH left, a recovery cannot pay for
   itself until someone tops the account up, and the thief can race each top-up. A thief can also fill the queue with spends: changing the
   daily key does not cancel them, so each needs a veto, and an unvetoed one still matures.
5. **A 64-leaf tree is a demo lifetime.** Rotation works. Backing up one-time key state across devices is the known unsolved
   problem of stateful hash signatures.
6. **Devnet only.** Chain 1337 can reset at any time, and the explorer keeps its history in memory. Recorded evidence is in
   [`docs/evidence/`](docs/evidence/). Recovery and the pool are on a local chain only, and their evidence cannot be checked on any
   public explorer: run them yourself.
7. **Quantum timelines are uncertain.** The claim is not that Q-day is close. It is that migration rails have to exist first.
