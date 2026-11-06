# VAJRA handoff notes

State at commit `ba303e5`, Friday 6 November 2026, 04:10 IST, with sections 3 and 7 updated later that day for recovery, the pool and the local mirror.

> **Read `docs/FINDINGS.md` section 8 first.** A thief with only the daily key can disable the master key on the deployed contract. Reproduced on the local mirror. The owner has
> approved the redeploy, and the source is fixed. **Not on chain 1337 yet:** whoever holds `.vajra/deployer.key` runs `stack/redeploy-public.sh`, then makes new demo accounts (task 9).

**Deadline: submit by 06:00 IST on Saturday 7 November.** That is the team's target from the spec. The event closes at 09:00 IST.

Contents:

1. [Read this first](#1-read-this-first)
2. [Getting set up](#2-getting-set-up)
3. [Status of every module](#3-status-of-every-module)
4. [What has been done, in detail](#4-what-has-been-done-in-detail)
5. [What is next](#5-what-is-next)
6. [Decisions already made](#6-decisions-already-made)
7. [What we may and may not say](#7-what-we-may-and-may-not-say)
8. [Live state](#8-live-state)
9. [Command reference](#9-command-reference)
10. [Traps](#10-traps)
11. [Working rules](#11-working-rules)
12. [Map of the repo](#12-map-of-the-repo)

---

## 1. Read this first

VAJRA is an Ethereum account that behaves like a bank account: daily limits, a public queue you can veto, freeze, and an escape to a
sealed harbor. Your everyday wallet is a limited daily key. A master key made of hash-based one-time signatures (WOTS) outranks it, so
a stolen seed phrase cannot empty the account, and a thief cannot stop your escape.

**The build is nearly finished.** 10 of 13 modules are built and running on live networks, including everything the submission depends
on. The other 3 are optional or design-only in the spec. What remains is mostly submission work, not coding.

**The next things to do, in order.** Task numbers match [section 5](#5-what-is-next), which has the detail.

| Task | What | Who | Time |
|---|---|---|---|
| 1 | Choose a licence, and answer "does development continue after Mumbai?" | Owner | 5 min |
| 2, 3 | Add the licence, and fix the two README gaps | Anyone | 15 min |
| 4 | Decide what to do with `04-VAJRA-FULL-SPEC.md`, then make the repo public | Owner | 15 min |
| 5 | Run the real board with Arkiv switched on | Whoever has the board | 5 min, 2 presses |
| 6 | Try real MetaMask once | Anyone | 15 min |
| 7 | Restrict the Arkiv access key | Owner | 2 min |
| 8 | Study block, so all three can explain the design | All three | 1 hour |
| 9 to 11 | Rehearse, record the video, submit | Team | Allow 3 hours |

**Three things that will catch you out:**

- The code is in a **private** GitHub repo, and the keys are **not in git**. See [section 2](#2-getting-set-up).
- Do not repeat claims from the two spec files without checking [section 7](#7-what-we-may-and-may-not-say). Several were proved wrong by
  measurement, and the README is the current truth.
- **Plugged into a compromised computer, the hardware signer gives up its key.** This is measured, it is a known limit, and it has to
  be said out loud at the demo.

---

## 2. Getting set up

### The code

The code is at `https://github.com/Vajra-8141/Vajra`, on `main`. The repo is private and the owner is the only member of the
`Vajra-8141` organisation, so ask the owner to add you first. Then:

    git clone https://github.com/Vajra-8141/Vajra.git vajra

It stays private until the owner decides otherwise, and nothing goes to upstream repos without the owner's say-so. A public repo is
required to submit, so that has to change ([section 5](#5-what-is-next), task 4).

### What is not in git

These have to be passed by hand, over a private channel, not a group chat.

| Item | What it is | Without it |
|---|---|---|
| `.env` | `ARKIV` (access key) and `DEV_WALLET_PRIVATE_KEY` (Arkiv writer wallet) | The registry is off. Everything else works |
| `.vajra/deployer.key` | Funds new accounts and deploys contracts | You cannot create accounts |
| `.vajra/daily.key` | The daily key of both demo accounts | You cannot spend from them, and the browser test fails |
| `.vajra/wallet.json` | The software account, with its harbor salt | That account cannot escape |
| `.vajra/signer.json` | **The software account's master seed and leaf counter** | That account has no master key |
| `.vajra/wallet.device.json` | The account paired with the real board, with its harbor salt | That account cannot escape |
| `03-VAJRA-SPEC.md` | The internal battle plan, gitignored on purpose | You lose the track notes and devnet traps |
| The ESP32 and LCD | The hardware signer | Use the software signer, and say so |

Not needed: `.vajra/devnet-deployer.key` and `.vajra/probe.key` were one-off. `.vajra/wallet.emulator.json` points at a temp file, so
delete it. `.vajra/registry-holder.key` identifies one machine's copy of a key and is recreated if missing, so each machine should
have its own.

> **Never use `signer.json` from two machines.** A copy of it is a second copy of a one-time key, which is the exact failure this
> project warns about. Two signatures from one leaf are enough to forge. Keep one live copy.

All of these keys are testnet or devnet only, and none holds real money. Keep them private anyway.

### Tools

| Tool | Version used | For |
|---|---|---|
| Node | 26.11.1. The README asks for 22.18 or newer, and only 26 has been run | Everything |
| pnpm | 9.4.0 | Workspace |
| Foundry | forge 0.2.0 | Contracts |
| g++ and make | any recent | Firmware tests and the emulator |
| PlatformIO | Core 6.2.0, in `~/.local/share/vajra-pio` on the owner's machine | Flashing the board |
| Chromium | at `/usr/bin/chromium`, hardcoded in the browser tests | Browser tests |

Serial access on Arch needs the `uucp` group and a fresh login. The owner's machine also has this in
`/etc/udev/rules.d/99-vajra-esp32.rules`:

    SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", MODE="0666"

### Check it works

    git submodule update --init
    pnpm install
    pnpm test               # 162 passing: 121 core, 41 CLI
    pnpm test:contracts     # 179 passing
    pnpm test:firmware      # 143 checks, 0 failures
    alias vajra='node packages/cli/src/main.ts'
    vajra status            # reads the devnet, needs .vajra/

These take about a minute together.

---

## 3. Status of every module

Status follows the spec's rule: a module is BUILT only if it runs on the live devnet.

| Module | Status | Proof |
|---|---|---|
| WOTS verifier and key tree | BUILT | Solidity checked against an independent TypeScript implementation |
| Dual-path account | BUILT | `docs/evidence/e2e-latest.json` |
| Daily limit, new-payee cooling, public queue, veto | BUILT | Same |
| Freeze, escape, sealed harbor | BUILT | Same |
| Key rotation | BUILT | Same |
| Stock wallets as the daily key | BUILT | personal_sign path mined. **Scripted wallet only, not the MetaMask extension** |
| ERC-8441 stealth, co-signed spend, paymaster | BUILT | `docs/evidence/stealth-latest.json`, passes the ERC's conformance vectors |
| Dashboard and exposure scanner | BUILT | Driven in a real browser over Nym. **Scripted wallet** |
| Master key on hardware | BUILT | `docs/evidence/device-esp32-latest.json` and `device-dashboard-latest.json` |
| Leaf registry on Arkiv | BUILT | `docs/evidence/arkiv-latest.json` |
| Nominee | NOT STARTED | Stretch item |
| Recovery by proof, Groth16 v1 | BUILT, LOCAL | `docs/evidence/recovery-latest.json`. Local mirror only |
| Shielded pool, fixed denomination v1 | BUILT, LOCAL | `docs/evidence/shielded-latest.json`. Local mirror only |
| STARK recovery and shielded v2 | DESIGNED | Spec §9, §10. **No STARK proof exists** |

See [`JUDGES.md`](JUDGES.md) for the mirror, and [`docs/ZK.md`](docs/ZK.md) for the design. New contract work goes in `VajraAccountV2.sol`, not `VajraAccount.sol`.

### Live results

| Run | Result | Evidence |
|---|---|---|
| `vajra e2e` | 11 mined, 21 refused, 0 failures | `docs/evidence/e2e-latest.json` |
| `vajra stealth` | 0 failures. 80,123 gas in `validateMaster` at 585 hashes | `docs/evidence/stealth-latest.json` |
| `vajra pin` | Thief's pending tx blocks the escape on canonical, alt mempool mines it. Confirmed three times | README |
| `device-e2e`, **real ESP32** | 7 mined, 6 host attacks refused, 0 failures. VERIFY 84,168 to 92,685 gas | `docs/evidence/device-esp32-latest.json` |
| Browser test, **real ESP32**, reads over Nym | 12 passed, 0 failed. Veto, freeze, unfreeze mined | `docs/evidence/device-dashboard-latest.json` |
| `vajra arkiv` | 20 passed, 0 failed | `docs/evidence/arkiv-latest.json` |

### Not yet proved

Say these plainly, and do not let them drift into "done":

- **The real board has not signed with Arkiv switched on.** That path has only run on the emulator ([task 5](#a-required-to-submit)).
- **Real MetaMask has never been used** ([task 6](#a-required-to-submit)).
- **`vajra arkiv` has not run to the end on the final code.** The final run was stopped by hand at step 4 with 12 passed and 0 failed. The
  full 20 of 20 ran just before two small read changes.
- **The last browser test with the Arkiv panel was cut off** by a time limit after all 11 of its checks through Unfreeze passed. The
  page checks after that (proof page, scanner, phone width) passed in earlier runs and do not touch Arkiv.
- **The upstream sidecar patch has now been compiled and run.** Its full test suite and e2e suite have not. See `docs/upstream/README.md`.

---

## 4. What has been done, in detail

### Contracts (`contracts/src/`, 57 tests)

- `Wots.sol`: WOTS verification with an unrolled Yul chain loop.
- `VajraAccount.sol`: the account. Constructor takes `(logW, len2, stakingRegistry)`. `validateDaily` and `validateMaster` run in VERIFY
  frames. `spend`, `executeQueued`, `veto`, `freeze`, `unfreeze`, `escape`, `rotateRoot`, `setDailyKey`, `setRule` and `setHarbor` run in
  SENDER frames.
- `VajraFactory.sol`: EIP-1167 clones. `SponsorPaymaster.sol`: naive stealth paymaster, as spec §8.4 allows.

The rulebook runs in the SENDER frame, because `TIMESTAMP` is banned in validation in every mempool. VERIFY enforces who may act and
what shape the transaction has. A daily-signed transaction that reaches a master function never becomes valid.

Hardened after testing: a split-approval fee cap bypass, and hostile tokens that could block an escape (malformed returns, return bombs,
gas burners). The escape uses bounded calls.

### Client core (`packages/core/src/`, runs in Node and the browser)

| File | What it does |
|---|---|
| `wots.ts` | Reference WOTS, key tree, `verifyMasterSignature` |
| `frame.ts` | Frame transactions: `masterTx`, `dailyTx`, `stealthTx`, `encodeTx`, `sigHash`, `submit` (rebroadcasts identical bytes), `refusalName` |
| `account.ts` | `prepareMasterTx`, `signMasterTx`, `readAccount`, `createAccount`, `predictAccount`, `ops`, `deployments` |
| `signer.ts` | `MasterSigner`, the software signer with write-ahead leaf tracking |
| `stealth.ts`, `exposure.ts` | ERC-8441 payments, and the exposure scanner's classifier |
| `devnet.ts` | `rpc`, `rpcBatch`, `setRpcFetch`, `routedFetch`, `withTimeout` |
| `registry.ts` | The Arkiv leaf registry: schemas, reads, writes, verification |
| `node.ts` | `loadOrCreateKey`, `fileStore`. Node only |

Deployed addresses live in `packages/core/src/deployments/1337.json`.

### CLI (`packages/cli/src/`, 24 tests)

`main.ts` is the entry point ([section 9](#9-command-reference)). `wallet.ts` holds master operations, `bridge.ts` the local HTTP service,
`device.ts` the serial client, and `registry.ts` the Arkiv decisions. The rest are the live test runs: `e2e`, `device-e2e`, `stealth`,
`pin`, `budget`, `measure`, `registry-e2e`.

Wallet files are kept apart so that no account can displace another: `wallet.json` (software), `wallet.device.json` (real board),
`wallet.emulator.json` (emulator).

`createWallet` pairs before it funds, so a missed press cannot strand ETH.

### Dashboard (`apps/dashboard/`)

Three pages: `/` (account), `/scanner` (exposure scanner), `/proof` (evidence). Reads go through `anon-rpc`, over the Nym mixnet by
default. If the route fails, the page stops rather than falling back to a direct connection. `components/leaves.tsx` is the Arkiv panel.

### Hardware (`firmware/`, 143 checks, details in `docs/HARDWARE.md`)

The board is an ESP32-D0WD-V3 (revision 3.1) with a CP2102 USB chip and a 16x2 LCD on a PCF8574 backpack at I2C `0x27`. Wiring: SDA to
GPIO 21, SCL to GPIO 22, VCC to VIN (5V), GND to GND. Set the blue contrast trimmer. No WiFi or Bluetooth is ever started.

`lib/vajra/` is the portable device logic. It parses the raw transaction itself, checks chain, account, shape and fee, decodes the
operation, shows it, waits for the button, saves write-ahead, and only then signs. `native/emulator.cpp` runs the same logic as a local
process.

Protocol at 115200: `INFO`, `PAIR`, `SIGN`, `PART`, `NEXTROOT`, `ROTATED`, `SHOW`, `WIPE`, `DIAG`. `SIGN` answers `OK SIGNED <leaf> <size>
<hash>`, and `PART <offset>` returns 128 bytes at a time. Repeating `SIGN` for the same digest costs no press and reveals nothing new.

**The board is flashed with the current logic.** The only firmware change since is a comment.

### Arkiv leaf registry (`packages/core/src/registry.ts`, `packages/cli/src/registry.ts`, `arkiv/`)

A one-time key must never sign twice. The signer's counter fails when a backup is restored, and the chain's nonce only moves when a
transaction is mined, so a signature that was revealed and never mined is invisible to it. Arkiv covers that gap.

Each master operation:

1. Reads what Arkiv holds for the key tree, from the signer's own counter upward.
2. Reserves the leaf with an entity that expires in 5 minutes.
3. Signs and broadcasts.
4. Publishes the signature as a usage record, even if the broadcast failed, because the leaf was revealed either way.

Rules built into it, each covered by tests:

- **Anyone can write to Arkiv, so nothing is believed because of who wrote it.** Records carry the signature, and every reader verifies
  it. A thief cannot forge "this key is spent" to block an escape.
- **A reservation can cost a leaf but never stop an operation.** It only counts from wallets in `ARKIV_WRITERS` or the local writer.
- **Freeze and escape do not wait for the reservation to be written.** The read before them gives up after 6 seconds, so a slow Arkiv
  costs an exit seconds at most.
- **A verified spent leaf is refused even for an escape,** because signing twice would destroy the key that is escaping.
- **If Arkiv does not answer, signing goes on** under the other two layers.

A software signer moves past a taken leaf. The hardware signer can only count forward by signing, so it refuses with `LeafUsedElsewhere`
or `LeafReservedElsewhere`.

The five required files are in `arkiv/`, and the README has the writer wallet and a runnable query, which was tested exactly as written.

### Docs and upstream

| File | Contents |
|---|---|
| `README.md` | The current truth, for judges |
| `docs/FINDINGS.md` | What we found about the devnet and sidecar |
| `docs/GAS.md` | The measured gas table |
| `docs/STEALTH.md` | Stealth design, and why the spec's version fails |
| `docs/HARDWARE.md` | Hardware, threat table, and what a computer can do to the board |
| `docs/DEMO.md` | The demo runbook, which replaces spec 03 §7 |
| `docs/upstream/` | `sidecar-budget-010.patch`, applying to sidecar commit `2e22ff0` |
| `ai/README.md` | How AI was used, required by the rules. Keep it current |

---

## 5. What is next

### A. Required to submit

**1. Licence and the open question (owner, 5 minutes).** The repo has no licence, and every Arkiv track requires an open-source one. MIT
is the suggestion. Then answer the one question in `arkiv/reach.md`: search for `TEAM TO ANSWER`. It asks whether development continues
after Mumbai, which only the team can commit to.

**2. Add `LICENSE` at the root.**

**3. Fix two README gaps (15 minutes).** Both are from spec 03 §5.

- EF qualification needs "a link to your admitted transaction on the devnet explorer". The README has no explorer link yet. Use the first
  transaction signed by the real board, and open it first, because the explorer keeps history in memory:
  `https://explorer.altmempool.wtf/tx/0x80e60964ed0188ff322f378934482e078303559226a286e542e661238e279920`
- The spec wants the judging criteria addressed by name: creativity, usefulness, practicality, how well it works, relation to the alt
  mempool. The README does not name them.

**4. Go public (owner).** History was rescanned before the first push, up to commit `453bfb2`: no private value from `.env` or `.vajra/`
appears in any commit, and `03-VAJRA-SPEC.md`, `.env` and `.vajra/` were never committed. The only matches were public account and
harbor addresses.

Decide first what to do with `04-VAJRA-FULL-SPEC.md`. It is tracked, so it goes public, and parts are out of date: it plans w=256 and
"~400k gas", and it carries old status tags. Add a note at the top pointing to the README, or remove it from the tree. Removing it
leaves it in history, and taking it out of history means a force-push that breaks every clone, so decide that before anyone clones.
Then:

    gh repo edit Vajra-8141/Vajra --visibility public --accept-visibility-change-consequences

**5. Real board with Arkiv on (5 minutes, 2 presses).** This has never run together. With the board plugged in:

    VAJRA_SIGNER=device node packages/cli/src/main.ts freeze      # LCD shows BOOT = approve: press once
    VAJRA_SIGNER=device node packages/cli/src/main.ts unfreeze    # press once
    VAJRA_SIGNER=device node packages/cli/src/main.ts leaves      # should list both, verified

Each should print `recorded leaf N on Arkiv`. Then update `docs/HARDWARE.md` and the README row.

**6. Real MetaMask (15 minutes).** Run `vajra bridge` and `pnpm --filter @vajra/dashboard dev`, open `http://localhost:3000`, connect
MetaMask, and spend. The wallet has to be the account's daily key, so import `.vajra/daily.key` into a test profile, or create an account
with `--daily <your address>`. Then remove "scripted wallet" from the README if it passes. If it fails, that is worth knowing before the demo.

**7. Restrict the Arkiv access key.** The dashboard includes it in the page. Arkiv's SDK says it is not a secret, but restrict it to your
origins at [hub.arkiv.network](https://hub.arkiv.network).

**8. Study block (1 hour, all three, Friday).** The EF track requires it: "Your team must be able to explain the design, the code and the
trade-offs." Cover WOTS on a whiteboard, the w tradeoff, EIP-8141 frames, ERC-8421 admission and staking, keyed nonces, the gas table, and
why a thief can block the exit on the public mempool. Use the Q&A in `docs/DEMO.md`.

**9. Rehearse.** Follow `docs/DEMO.md`. Note that the demo account's harbor is `0x…dEaD`, and a real escape ends that account. Before a
rehearsal that presses escape, make a fresh one with a harbor you control. This takes one press to pair, and 0.02 ETH from the deployer:

    mv .vajra/wallet.device.json .vajra/wallet.device.old.json
    VAJRA_SIGNER=device node packages/cli/src/main.ts create --harbor 0xYourAddress --delay 120 --cooling 60 --limit 0.001 --allowance 0.0002 --fund 0.02

**10. Video.** At least 720p, no AI voiceover, no speed-ups, 3 minutes at most. `docs/DEMO.md` is the 4-minute live version, so it needs
cutting. Record against live networks, and keep `docs/evidence/` open in case the devnet resets.

**11. Submit by 06:00 Saturday.** Per spec 03: Finalist track, EF (Best use of the Frame Transaction Alternative Mempool), and Arkiv ("Build
on Arkiv (from scratch)"). The third pick stays empty on purpose. Confirm the rules at
[the prize page](https://ethglobal.com/events/mumbai/prizes/arkiv).

### B. Worth doing if there is time

- **Take `docs/FINDINGS.md` and the patch to the track authors.** The spec names Pierre and Alex. It is third-party verification from the
  people who wrote the protocol. Be clear that the patch has only had its logic tests run.
- **Compile the patch in the sidecar.** Done, on the owner's instruction, with the mirror.
- **Run `vajra arkiv` to the end on the final code,** so the evidence matches exactly. 5 minutes, about 0.05 tGLM and 0.004 ETH.
- **Run the browser test once more at the end.** 8 minutes.

### C. Stretch, not started

Nominee. Uno air-gap signer. SHA-256 precompile variant for the gas table. Batch exposure measurement. STARK recovery and shielded notes
scaffolding. A hosted dashboard, so judges need no install. Pick these up only after everything in A is done.

---

## 6. Decisions already made

Please do not reopen these without talking to the owner.

| Decision | Why |
|---|---|
| Ship on **w=16**, not w=256 | The live sidecar caps validation at 100,000 gas even for staked senders. w=16 fits (90,009), and w=256 does not (334,362) |
| The pitch is **"a thief can't block your exit"** | We expected PQ signatures to exceed the budget and measured otherwise. The real need for the alt mempool is the blocked escape |
| **BOOT stays** as the confirm button | Owner's decision. A button on GPIO 4 plus burning `UART_DOWNLOAD_DIS` would close the host attack, and it was declined. Do not raise it again unless the owner does |
| **Never burn an eFuse** without the owner's explicit say-so at that moment | It is permanent, and it would end USB flashing of the board |
| Repo stays private until the owner says | Owner's decision, which submission will have to change |
| Arkiv is a go | Core finished well before the Friday 10:00 go/no-go |
| Stealth needs **two signatures** | The sender knows `ss`, so the spec's hash key alone would let a sender take the money back. See `docs/STEALTH.md` |
| The sender deploys the stealth account | A deploy frame does not fit in the 100,000 cap alongside VERIFY and the paymaster |
| Usage records carry the signature | Otherwise a thief could forge one and block an escape |
| On Nym, the dashboard asks before reading Arkiv | Arkiv refuses that route, and falling back quietly would break the README's privacy promise |

---

## 7. What we may and may not say

The honesty ledger is load-bearing: mocked output is labelled as design, the measured number replaces the estimate, and the privacy
boundary is stated before anyone asks. The two spec files were written before the measurements, so **the README wins**.

| Do not say | Say instead |
|---|---|
| "Post-quantum signatures exceed the mempool budget" | At w=16 full verification costs about 90,000 gas and fits under the cap |
| "The public mempool refuses our transaction on gas" | Both refuse over 100,000. The difference is the blocked exit |
| "Remove the alt mempool and the product cannot exist" | A thief with a pending transaction can block the escape on canonical. With none pending, canonical takes it too |
| "The escape can never be blocked anywhere" | The block lasts while a thief transaction is pending, and on this idle devnet that means one every slot |
| "It signs nothing without a press" | **False on this board.** The host can press BOOT through DTR |
| "Malware cannot reach the key" | True only while it is unplugged. Plugged in, any program can copy it in half a second |
| "Cut the cable and the key is unreachable" | Fine as a statement about the network, not about a computer it is plugged into |
| "This is production post-quantum cryptography" | Unreviewed parameters. Plain keccak chains give multi-target attacks about a 19-bit discount. Production means LMS, XMSS or SPHINCS+ |
| "The sender cannot spend, ever" | A sender who also owns a quantum computer can. See `docs/STEALTH.md` |
| "The thief cannot stop your escape" | A pending transaction cannot. On the deployed contract a thief with the daily key can disable the master key: `docs/FINDINGS.md` section 8 |
| "Hidden balances" | A local pool that hides which deposit paid a withdrawal. The chain still shows the account paid the recipient |
| "STARK recovery" | Groth16 recovery, locally. Not post-quantum. STARK is designed, and no STARK proof exists |
| "Runs on the devnet", of recovery or the pool | Runs on a local mirror. The deployed sidecar refuses them |
| "All reads are private" | Dashboard chain reads are. Arkiv reads are not on Nym, the bridge connects directly, and sending shows your IP to the mempool |
| "Tested with MetaMask" | Scripted wallet, until task 6 passes |

If the master key on stage is the software signer, say so.

---

## 8. Live state

### Networks

| | EIP-8141 devnet | Arkiv testnet (Rabdi) |
|---|---|---|
| Chain | 1337 | 7,794,095 |
| RPC | `https://altmempool.forshtat.com` | `https://rpc.rabdi.db-chain.testnet.arkiv.network` |
| Alt mempool | `https://altmempool.forshtat.com/rpc` | |
| Explorer | `https://explorer.altmempool.wtf` | `https://rabdi.explorer.arkiv.network` |
| Funds | Faucet dry, no easy top-up | tGLM from `hub.arkiv.network/faucet` |

### Contracts on chain 1337

| Contract | Address |
|---|---|
| w=16 implementation | `0x8095ce1a02b7b6cc913b706bb0bd7c21c29274fd` |
| w=16 factory | `0x7f25b10a43e475620b52727506bf0aceb0076ca0` |
| w=256 implementation | `0xb7d197697a0c967d08ab2d3787b77b7944321772` |
| w=256 factory | `0x47700cefbceb52c47a7774377b0d18593c3e2547` |
| Paymaster | `0xfe02203607bec1ca841a7d7d14587790d5830b6b` |
| ERC-5564 announcer | `0xefd71128f0f04dcf991e0b30249078162cac8154` |
| ERC-6538 registry | `0x1b05f67c871e00fb52a40d2293d3d77133d4623f` |

### Accounts and funds

Balances as of 04:10 IST.

| What | Address | Balance | Notes |
|---|---|---|---|
| Deployer | `0x8f74d0ddd00ABc746045b7322148935F5643311B` | 0.2035 ETH | **Scarce.** A full redeploy costs about 0.1 ETH, so keep that in reserve |
| Device account (demo) | `0x4E0663ec61E7Ac880b62b479825032CE189C7e5c` | 0.0170 ETH | Paired with the board, 54 leaves left. Limit 0.001, allowance 0.0002, delay 120 s, cooling 60 s |
| Software account (fallback) | `0x7F2194e5d92c8324CEc002F2f45e4FfA405952f1` | 0.0121 ETH | `.vajra/signer.json`, 49 leaves left. Limit 0.001, delay 90 s, cooling 30 s |
| Emulator account | `0x31b1f89A2adF6B03Fd33019Ed1Fb8f8E4A5b037c` | 0.0027 ETH | Disposable |
| Arkiv writer | `0x8108ac6F8eb2945E11938176b7c3EdfC17fF478c` | 9.835 tGLM | `DEV_WALLET_PRIVATE_KEY`. Listed in the README |

Both demo accounts use daily key `0x68FC4ee4B6eCfB1C233eFCF972EBFE25AE5F3d63` and harbor `0x000000000000000000000000000000000000dEaD`.
Neither is frozen, and neither has a pending queue item: all 8 items were vetoed. Two old test accounts hold stranded devnet ETH, which
can be ignored.

**The board:** on tree 1, next leaf 9, paired to the device account, idle.

**On Arkiv:** the evidence key tree is `0xced04393930ba48b36d6e92db07d8b9996e102823f2d303b9c5d7384d139a2fa`, with 3 verified uses and 1 forged
record. Usage records last 180 days, so they outlive judging. The device account has no records yet, because its operations predate the
registry. Task 5 creates the first ones.

---

## 9. Command reference

    alias vajra='node packages/cli/src/main.ts'

| Command | What it does |
|---|---|
| `vajra create --harbor <address>` | New account. Flags: `--daily --limit --allowance --delay --cooling --fund` |
| `vajra status` | Account, signer and registry state |
| `vajra spend <to> <eth>` | Spend with the daily key |
| `vajra veto <id>`, `freeze`, `unfreeze`, `escape`, `rotate`, `set-daily <address>` | Master operations |
| `vajra bridge` | Local service on `127.0.0.1:8787`, answering `http://localhost:3000` |
| `vajra device` | Show what the signer reports. `vajra device wipe` **erases the key**: do not run it casually |
| `vajra leaves [root]` | What Arkiv knows about a key tree. Works with no keys |
| `vajra deploy [w16\|w256\|stealth]` | Redeploy. Costs about 0.1 ETH in all |

Dashboard: `pnpm --filter @vajra/dashboard dev`, at `http://localhost:3000`.

Flash the board, from `firmware/`: `pio run -e esp32 -t upload --upload-port /dev/ttyUSB0`. Key and leaf state in NVS survive a flash.

### Environment variables

| Variable | Meaning |
|---|---|
| `VAJRA_SIGNER=device` | Use the hardware signer. Without it, the software signer |
| `VAJRA_DEVICE=emulator:<file>` | Use the emulator. Build it with `make -C firmware emulator` |
| `VAJRA_DEVICE=/dev/ttyUSB1` | Use a specific port |
| `VAJRA_CONFIRM=no` | Emulator declines every prompt |
| `ARKIV`, `DEV_WALLET_PRIVATE_KEY` | In `.env`. The registry is off without them |
| `ARKIV_WRITERS` | Other wallets whose reservations to respect, comma separated |
| `ROUTE`, `SHOTS`, `GATE` | For `apps/dashboard/test/flows.mjs` |

### Live tests

These write to the live networks and cost funds. **Do not repeat them for coverage you already have.**

| Command | Time | Spends | Presses |
|---|---|---|---|
| `vajra e2e` | About 5 min | Deployer ETH | 0 |
| `vajra stealth`, `pin`, `budget`, `measure` | A few minutes each | Deployer ETH | 0 |
| `vajra arkiv` | About 5 min | 0.004 ETH, 0.05 tGLM | 0 |
| `VAJRA_SIGNER=device node packages/cli/src/main.ts device-e2e` | About 5 min | 0.015 ETH | 9 |
| `node apps/dashboard/test/flows.mjs` | About 8 min | The account's ETH | 3 with the board |

`flows.mjs` needs the bridge and dashboard running. For a person at the board, use the gate, so that nothing appears on the LCD until they
are ready:

    rm -rf /tmp/gate && mkdir /tmp/gate
    GATE=/tmp/gate ROUTE=nym node apps/dashboard/test/flows.mjs
    # when it prints "ready: veto", tell them, then in another terminal:
    touch /tmp/gate/veto      # the same for freeze, then unfreeze

### Pressing BOOT

**Press once when the LCD shows `BOOT = approve`. If it does not show that, do not press.** The top line is what you are approving. The
second line alternates with the details every few seconds. A prompt times out after 60 seconds, which returns `Declined` and burns no
leaf. A press on the idle screen does nothing.

---

## 10. Traps

### Devnet

- **About 1 transaction in 20 is cancelled by the node.** `submit` rebroadcasts the same bytes, adding about 30 seconds. Not a failure.
- **`not mined in time` does not mean it failed.** `submit` gives up at 180 seconds, and one veto mined after that. Check the receipt
  before retrying.
- **The explorer keeps history in memory,** and the devnet can reset at any time. `docs/evidence/` is the backup. `vajra deploy` restores
  the contracts, and the proof page is the fallback.
- **Gas is resource-based.** A transfer to a new account needs far more than 21,000, and default estimators fail. Deploys need a 30M gas
  limit. `docs/GAS.md` has the model.
- **The validation cap is 100,000 even for staked senders,** and precompiles are refused in validation. That is why `ecrecover` is not
  used there. Full detail in `docs/FINDINGS.md`.
- **Do not call `debug_bundler_*`** set or clear methods. They are open to everyone, and another team could use them on us.
- **Do not use the shared genesis key.** It is the node's relayer.

### Hardware and serial

- **`READ_WAKE_MS` in `packages/cli/src/device.ts` must stay.** On Node 26 with serialport 13, after the first read, serial data does not
  wake the event loop. A 10 ms timer works around it. The cause is unknown. Removing it brings back the original bug: replies sit
  unread, and a port holds only about 4 KB.
- **`espefuse` can leave the chip in its bootloader.** Afterwards the client says `the signer did not answer`. Press EN, or pulse RTS.
- **A USB-C port on the owner's machine dropped the board.** If it vanishes, try another port.
- **The LCD needs VIN, not 3V3,** plus the contrast trimmer. A row of solid blocks is contrast. `DIAG` reads the LCD's memory back to prove
  the text is there. 5V on the I2C lines is out of spec for the ESP32, and it works.
- **Logs with NUL bytes:** `grep` treats them as binary and prints nothing. Read them with Python.

### Arkiv

- **The keyless endpoint has a small budget.** Past it, the server answers `429 ANON_COST_LIMITED` with `Retry-After: 1229`, and viem
  silently waits 20 minutes. Reads use `retryCount: 0` for this reason, so do not remove it.
- **Do not run two writers at once.** The bridge and `vajra arkiv` share a wallet, and they will collide on nonces.
- **Never publish a slow query shape.** That is a disqualifier: send those to the Arkiv team privately. Keep them out of the repo,
  `friction.md` and the demo.
- **Do not query by `account`** for anything shown as trusted. Anyone can write valid signatures from their own tree and claim your
  account. Filter by `root`.
- **Stealth accounts stay off Arkiv,** and so does the harbor. See `arkiv/why-arkiv.md`.

### Dashboard

- `pnpm build` and `pnpm dev` copy the evidence files. `npx next build` does not.
- Restart the bridge after changing CLI code.
- Nym takes 20 to 40 seconds to come up. Let it finish before going on stage.
- `apps/dashboard/AGENTS.md` is generated by Next and gitignored.

---

## 11. Working rules

From spec 04 §0 and the owner. They are binding.

1. **Commits carry no attribution.** No `Co-Authored-By:` lines, no "Generated with" lines, no tool attribution in commit messages or PR
   descriptions. Commits belong to the team members who make them. Check that your tools do not add these. Every commit so far is clean.
2. **Never create artifacts.** No hosted pages or cloud docs. Every document is a plain `.md` file in the repo.
3. **The honesty ledger is load-bearing.** See [section 7](#7-what-we-may-and-may-not-say). Update the docs when a result changes.
4. **Build real things.** A convincing simulation of something that should be real is a defect. If a real integration is not feasible, say
   so early, and get agreement first.
5. **Never commit keys.** `.env`, `.vajra/` and `03-VAJRA-SPEC.md` are gitignored. Keep them that way.
6. **Keep a steady commit cadence** across the build window.
7. **Keep long runs short.** Only rerun what your change touched.

---

## 12. Map of the repo

    README.md                     the current truth, for judges
    HANDOFF.md                    this file
    04-VAJRA-FULL-SPEC.md         engineering spec, partly out of date
    03-VAJRA-SPEC.md              battle plan, gitignored
    contracts/src/                VajraAccount, Wots, VajraFactory, SponsorPaymaster
    packages/core/src/            WOTS, frames, accounts, stealth, exposure, Arkiv registry
    packages/core/test/           105 tests
    packages/cli/src/             the wallet, bridge, serial client and live tests
    packages/cli/test/            24 tests
    apps/dashboard/               Next.js dashboard, and browser tests in test/
    firmware/src/main.cpp         ESP32 hardware layer
    firmware/lib/vajra/           portable device logic
    firmware/native/              the emulator
    firmware/test/                143 checks
    docs/                         findings, gas, stealth, hardware, demo
    docs/evidence/                recorded live runs
    docs/upstream/                sidecar patch for the track authors
    arkiv/                        the five files the Arkiv track requires
    ai/README.md                  how AI was used
