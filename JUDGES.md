# Running VAJRA yourself

One command boots a full local copy of everything: ethrex, a block producer, the alternative mempool, an explorer, and every contract.

Needs Docker, Node 22.18 or newer, pnpm, make, and git.

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
| Sidecar | as deployed | with [`docs/upstream/sidecar-budget-010.patch`](docs/upstream/), which restores BUDGET-010 and CALLING-040 |
| Chain id | 1337 | 13370, so that a local result cannot pass for a public one |
| Consensus | Lighthouse, 6 s slots | `stack/miner.mjs` drives the engine API, 2 s slots. Every block is still built and validated by ethrex |
| Hegota | from epoch 2 | from genesis |
| USDC | the devnet's | a plain ERC-20 stand-in at the same address |
| Account for proofs | not deployed | `VajraAccountV2` |

Everything the README marks BUILT was recorded on the public devnet, in `docs/evidence/`, some of it before the reset of 2026-11-06. Recovery and the pool run only here, because
the deployed sidecar cannot admit them. Running a flow here does not touch those records: its result goes to `.vajra-local/evidence/`.

On running locally, the EF's words: "a local sidecar is fine for judging". On the gas budgets: "no science behind any of the gas limits".

## Every capability, one command

Times are from one machine, on a warm mirror.

| Capability | Command | Takes | Expect |
|---|---|---|---|
| Rulebook, and every attack on it | `vajra e2e` | 2.5 min | 11 mined, 22 refused, 0 failures |
| The blocked escape, on both mempools | `vajra pin` | 15 s | canonical refuses, alt mines |
| Stealth payment and paymaster | `vajra stealth` | 20 s | 0 failures |
| Recovery by proof, and every attack | `vajra recover` | 70 s | 8 mined, 21 refused, 0 failures |
| Recovery, step by step, on the demo account | `vajra recover-setup`, `recover-prove --secret <file>`, `recover --proof <file>` | 1 min | the new tree signs |
| The shielded pool, and every attack | `vajra shielded` | 80 s | 12 mined, 24 refused, 0 failures |
| One note in, one note out | `vajra shield`, `vajra unshield 0xAddress` | 10 s each | the recipient holds 0.095 ETH: a 0.1 ETH note, less its fee |
| The same proof on the sidecar as deployed and as patched | `make unpatched`, then `vajra compare` | 2 min | refused, refused, mined |
| The flaw in the contract as first deployed, and its fix | `vajra nonce-burn`, then `vajra nonce-burn fixed` | 2 min | 64 of 64 leaves burned and the escape refused, then 0 of 64 and admitted |
| A stealth payer taking the money back, and the fix | `vajra stealth-theft`, then `vajra stealth-theft fixed` | 1 min | 25 of 25 taken, then `CoSignerRequired` and 0 taken |
| The dashboard, on the mirror | `make dashboard`, then http://localhost:3000 | 30 s | a banner saying it is local. Use a wallet holding `.vajra-local/daily.key` |
| Releasing a queued payment early, and the race that must not pay twice | `vajra pay-e2e` | 40 s | 0 failures |
| The phone alert, with a local stand-in for Telegram's servers | `vajra watch-e2e` | 1 min | a stranger refused, Pay refused on software, then cancel and pay both land |
| The phone alert, for real | a bot from @BotFather, `TELEGRAM_BOT_TOKEN` in `.env`, then `vajra watch` | | Tried on Nov 6 with a real bot and a real phone, on the mirror: two **Not me** taps cancelled, one **Pay, it's me** tap paid 0.5 ETH. Pay used the software signer (`--allow-software-pay`) |
| Gas table | `vajra measure`, `vajra measure-zk` | 2 min each | close to `docs/GAS.md` |
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

## Reading a refusal

Each attack is really sent, and has to die with the name shown. A run that says `0 failures` means every attack got that exact name. An
attack that was admitted would print `FAIL`, and the run would exit non-zero.

## Troubleshooting

- **ARM machines.** Upstream publishes ethrex for amd64 only, so Docker runs it under emulation. **This has not been tested.** It was
  built and run on x86-64 Linux.
- **A port is taken.** The mirror uses 18545, 14337, 14338 and 18080, on 127.0.0.1.
- **Start again.** `make judge` always starts from an empty chain. `make down` stops everything.
- **`not mined in time`.** Check that the `miner` container is running: `docker compose -f stack/docker-compose.yml ps`.
