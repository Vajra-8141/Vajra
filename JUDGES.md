# Running VAJRA yourself

One command boots a full local copy of everything: ethrex, a block producer, the alternative mempool, an explorer, and every contract.

Needs Docker, Node 22.18 or newer, pnpm, make, and git.

The contract tests also need Foundry and `git submodule update --init`. The browser tests look for `/usr/bin/chromium`: set `CHROMIUM=/usr/bin/brave-browser` if you use Brave, and `ROUTE=direct` for `apps/dashboard/test/flows.mjs` on the mirror.

    git clone https://github.com/Vajra-8141/Vajra.git && cd Vajra
    make judge

It ends by printing `GREEN` and a demo account. Measured from a fresh clone, with cold image builds and an empty pnpm store: 155 seconds on one 16-core
machine, not counting the download of three base images (ethrex, bun, node).

    alias vajra='VAJRA_STACK=local node packages/cli/src/main.ts'

## What this is

**A mirror, not a sandbox.** It runs the two upstream commits the public devnet runs: ethrex `9aa3645`, the image pinned by commit, and
the sidecar `2e22ff0`. The differences, all of them:

| | Public devnet | Local mirror |
|---|---|---|
| Sidecar | as deployed: no validation gas cap, precompiles allowed | with [`docs/upstream/sidecar-budget-010.patch`](docs/upstream/), which restores BUDGET-010 and CALLING-040. `sidecar-reputation.patch` goes on top only if you ask: `VAJRA_SIDECAR_RULE=1` |
| Chain id | 1337 | 13370, so that a local result cannot pass for a public one |
| Consensus | Lighthouse, 6 s slots | `stack/miner.mjs` drives the engine API, 2 s slots. Every block is still built and validated by ethrex |
| Hegota | from epoch 2 | from genesis |
| USDC | the devnet's | a plain ERC-20 stand-in at the same address |
| Account for proofs | `VajraAccountV2` | `VajraAccountV2` |

Everything the README marks BUILT was recorded on the public devnet, in `docs/evidence/`, some of it before the reset of 2026-11-06. Recovery and one note through the pool also ran there on 6 November, once the alt mempool allowed precompiles: `recovery-public-latest.json`, `shield-public-latest.json`. The attack suites, paymasters and the full pool suite run here. `e2e` and `stealth` here do not touch those records: their results go to `.vajra-local/evidence/`. Other suites, such as `recover` and `shielded`, rewrite their file in `docs/evidence/`, labelled as mirror runs.

On running locally, the EF's words: "a local sidecar is fine for judging". On the gas budgets: "no science behind any of the gas limits".

## Every capability, one command

Times are from one machine, on a warm mirror.

| Capability | Command | Takes | Expect |
|---|---|---|---|
| Rulebook, and every attack on it | `vajra e2e` | 2.5 min | 11 mined, 22 refused, 0 failures |
| The blocked escape, on both mempools | `vajra pin` | 15 s | canonical refuses, alt mines |
| Stealth payment and paymaster | `vajra stealth` | 20 s | 0 failures |
| Recovery by proof, and every attack | `vajra recover` | 70 s | 12 mined, 24 refused, 0 failures |
| Recovery, step by step, on the demo account | `vajra recover-setup`, `recover-prove --secret <file>`, `recover --proof <file>` | 1 min | the new tree signs |
| The shielded pool, and every attack | `vajra shielded` | 80 s | 12 mined, 30 refused, 0 failures |
| One note in, one note out | `vajra shield`, `vajra unshield 0xAddress` | 10 s each | the recipient holds 0.095 ETH: a 0.1 ETH note, less its fee |
| The same proof on the sidecar as deployed and as patched | `make unpatched`, then `vajra compare` | 2 min | refused, refused, mined |
| The flaw in the contract as first deployed, and its fix | `vajra nonce-burn`, then `vajra nonce-burn fixed` | 2 min | 64 of 64 leaves burned and the escape refused, then 0 of 64 and admitted |
| A thief banning the account on a node, and the way round it | `vajra rep-burn`, then `vajra rep-burn fixed` | 1 min each | banned in about 8 seconds, and escape, veto, recovery and a paymaster all refused. Then all three mined from the exit |
| The same attack on the proposed sidecar rule | `VAJRA_SIDECAR_RULE=1 make judge`, then `vajra rep-burn rule` | 4 min, with the build | seen does not move, and everything is admitted. This changes the mirror, so `make judge` again afterwards |
| An escape the mempool will not hold, and the way round it | `vajra escape-solvency`, then `vajra escape-solvency fixed` | 40 s each | `cannot cover`, then `Cancelled`. The second is a race, so it can come out the other way. Then the exit carries the tokens out |
| The second route, and every attack on it | `vajra exit-e2e` | 45 s | 10 mined, 25 refused, 0 failures, with an escape mined through the canonical mempool past a pending thief transaction |
| One note in many places, a note burning fees, a public ticket | `vajra proof-spam`, then `vajra proof-spam fixed` | 1 min each | 6 of 6 admitted, the note alive after 3 burns, a pairing run. Then 1 of 6, the note spent, `RecoveryGateInvalid` |
| A wallet signing typed data, and every attack on it | `vajra clear-sign` | 25 s | 4 mined, 18 refused, 0 failures, with a scripted wallet |
| A second way out, on your own account | `vajra exit-setup`, then `vajra exit` | 20 s each | the harbor holds the balance |
| A stealth payer taking the money back, and the fix | `vajra stealth-theft`, then `vajra stealth-theft fixed` | 1 min | 25 of 25 taken, then `CoSignerRequired` and 0 taken |
| A nominee: a rescue signed in advance, sent when nobody answers, and every attack on it | `vajra nominee-e2e` | 11 min | 34 mined, 21 refused, 0 failures. Holds no key: a real process with an empty folder, which it leaves empty. A node dying, a stuck head and a sidecar going down are a proxy in front of the real chain, which refuses, replays an old block, and answers for a sidecar that sits on a transaction |
| The same, on your own account | `vajra exit-setup --reserve 0.03`, `vajra nominee-setup --out rescue.json`, `vajra nominee-watch --rescue rescue.json` in its own terminal, then `vajra thief 0.6` and answer nothing | 2 min | the harbor holds the balance, and the watcher stops by itself. It ends the demo account: `make judge` starts again |
| The dashboard, on the mirror | `make dashboard`, then http://localhost:3000 and **Start the demo** | 30 s | the theft as six steps, with no wallet to set up. See below |
| Quota and USDC paymasters, and every attack | `vajra paymaster-e2e` | 6 min | 15 mined, 50 refused, canonical refused 51 of 51, 66 predictions checked, on V2, 0 failures |
| Why a transaction went the way it did | `vajra explain 0xHash` | 1 s | state, frames, both verdicts, the sidecar's rules. Unknown stays unknown |
| The SDK, every action | `node packages/sdk/examples/mirror.ts`, with `VAJRA_STACK=local` | 30 s | a spend, a queue, a veto |
| A precompile in validation, on both sidecars | `make unpatched`, then `vajra precompile-check` | 1 min | refused as deployed, admitted as patched |
| Releasing a queued payment early, and the race that must not pay twice | `vajra pay-e2e` | 40 s | 0 failures |
| The phone alert, with a local stand-in for Telegram's servers | `vajra watch-e2e` | 1 min | a stranger refused, Pay refused on software, then cancel and pay both land |
| The phone alert, for real | a bot from @BotFather, `TELEGRAM_BOT_TOKEN` in `.env`, then `vajra watch` | | Tried on Nov 6 with a real bot and a real phone, on the mirror: two **Not me** taps cancelled, one **Pay, it's me** tap paid 0.5 ETH. Pay used the software signer (`--allow-software-pay`). **Not me** also passed on the public devnet |
| The phone app, in a real browser | `pnpm install`, `pnpm --filter @vajra/phone build`, then `node apps/phone/test/e2e.mjs` | 2 min | 0 failures. Needs Brave or Chrome, set with `CHROMIUM`. The push service and Telegram are local stand-ins here |
| Web Push, nothing stood in for | `node apps/phone/test/real-push.mjs` | up to 5 min | a notification through Google's push service. Needs Brave and internet |
| The phone app, by hand | `vajra phone`, then open the link in `.vajra-local/phone-pair.txt` | | Add `--allow-software-pay` for **Pay, it's me** |
| The extension, in a real browser | `pnpm --filter @vajra/extension build` with `VAJRA_STACK=local`, then `node apps/extension/test/e2e.mjs` | 2 min | 0 failures. The Playwright headless shell cannot load extensions, so this needs Brave or Chrome. By hand: load `apps/extension/dist` unpacked |
| Encrypted backup, restore, a stale state refused | `vajra backup-e2e`, or `vajra backup --out file`, `vajra restore --in file --check` | 1 min | 0 failures |
| One-transaction move from an EOA | `vajra move-e2e`, or `vajra move --key-file file --harbor 0x… --tokens 0x…` | 40 s | three frames, one transaction, 0 failures |
| Gas table | `vajra measure`, `vajra measure-zk` | 2 min each | close to `docs/GAS.md` |
| leanSphincs-S, a hash key with no leaves, beside the one we use | `vajra sphincs-bench` | 9 min | 19 mined, 54 refused, 0 failures, with its numbers close to `docs/GAS.md`. `SAMPLES=4` makes it 5 min. A benchmark: no account relies on it. One mined transaction shows a flaw on purpose: `docs/FINDINGS.md` section 21 |
| A staked VERIFY limit over 100,000 | `vajra budget` | 5 s | 400,000 admitted. The 900,000 line says "fee too low": same nonce, not the cap |
| Hardware logic | `make -C firmware test emulator`, then the three lines below | 1 min | 143 checks, then 7 mined |
| Leaf registry | the `curl` under [Run a query](README.md#leaf-registry-on-arkiv) in the README | 1 s | the public Arkiv testnet, no install, no key |
| Explorer | http://127.0.0.1:18080 | | the sidecar's own: pool, activity, rule-by-rule admission reports |

The emulator runs the firmware's logic as a local process. It tests the logic and the protocol, not the hardware:

    export VAJRA_SIGNER=device VAJRA_DEVICE=emulator:/tmp/vajra-emulator.json
    vajra device-e2e
    unset VAJRA_SIGNER VAJRA_DEVICE

Tests that need no chain:

    pnpm install && git submodule update --init
    pnpm test && pnpm test:contracts && pnpm test:firmware

## The dashboard, with no wallet

`make dashboard` opens on a landing page. **Start the demo** goes to `/story`: the theft as numbered steps. Each tick comes from the chain or the mempool, and every term has a tooltip. If something is not running, the page shows a checklist with the next command instead of an error, and it clears by itself.

| Page | What it does |
|---|---|
| The story, `/story` | Pay, steal, get the alert, cancel, and try to replace the hash key |
| Try to break in | 17 real attacks through the bridge, each with its named refusal and the node's raw error. The same attacks `vajra e2e` builds, from `packages/cli/src/attacks.ts` |
| Mempools | One signed transaction to the canonical and alt mempools side by side, with raw errors and gas per frame. Reuses `vajra pin` and `vajra budget` |
| Your nominee | Load a rescue file, with no wallet. It says whether the rescue would work, what is waiting, and when it goes, and sends it by itself or by hand. `apps/dashboard/test/nominee.mjs` drives it, 0 failures |
| Lifecycle | New, Submitted, then Mined or Cancelled with a reason, and reputation, from the sidecar's `skandha_explorer` methods |
| Proof | Every file in `docs/evidence/`, grouped by where it really ran |

**The demo signer.** On the mirror the bridge signs as the daily key, with the throwaway key in `.vajra-local/daily.key`, so no wallet import is needed. The page labels it. It does not exist on the public chain: every demo route refuses unless the bridge runs with `VAJRA_STACK=local` and the node answers as chain 13370, and a dashboard built for the public chain shows no such button. To use your own wallet instead, import that key and open the Account page.

**The phone in the story is a stand-in** drawn by the page, and it says so. No message is sent. Its button is real: a hash key veto, mined on the mirror. For the real alert, see `docs/DEMO.md`.

**The gas limits.** The canonical path still refuses a validation prefix over 100,000. The mirror's patched sidecar keeps per-entity budgets of 100,000 and 1,000,000. The public alt mempool has since dropped its cap, so those budgets describe this mirror, not the public mempool, and the dashboard does not test the public one.

Screenshots are in `docs/screenshots/`. The browser tests are in `apps/dashboard/test/`: `demo.mjs` runs everything above with no wallet in the page.

## A read-only proof page

    pnpm --filter @vajra/dashboard run export:proof

This builds one static page into `apps/dashboard/out/`, from `docs/evidence/`: no wallet, no bridge, no chain reads. It labels each record as public, public before the reset, or mirror. It is built to be hosted, and it has not been.

## Reading a refusal

Each attack is really sent, and has to die with the name shown. A run that says `0 failures` means every attack got that exact name. An
attack that was admitted would print `FAIL`, and the run would exit non-zero.

## Troubleshooting

- **ARM machines.** Upstream publishes ethrex for amd64 only, so Docker runs it under emulation. **This has not been tested.** It was
  built and run on x86-64 Linux.
- **A port is taken.** The mirror uses 18545, 14337, 14338 and 18080, on 127.0.0.1.
- **Start again.** `make judge` always starts from an empty chain. `make down` stops everything.
- **`not mined in time`.** Check that the `miner` container is running: `docker compose -f stack/docker-compose.yml ps`.
