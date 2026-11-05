# VAJRA — Complete Engineering Specification

**Supersedes nothing, extends `03-VAJRA-SPEC.md`.** That file holds the hackathon battle plan (devnet endpoints, judge scripts, Devcon ammo). This file is the full technical specification of everything VAJRA is and is becoming — including Step 3 (STARK recovery, shielded notes), which is now **in build**, not just on a slide. Time-boxing rules from 03 still govern what ships by the Nov 7 deadline; this document does not care about the deadline.

---

## 0. Working rules (binding on everyone and every tool touching this repo)

1. **Git: push without co-author. Always.** No `Co-Authored-By:` lines, no "Generated with" lines, no tool attribution in commit messages or PR descriptions. Commits belong to the team members who make them. Steady commit cadence across the build window (single-dump histories risk disqualification and look like exactly what they are).
2. **Never create artifacts. Ever.** No claude.ai artifacts, no hosted pages, no cloud docs. Every document is a plain `.md` file in the repo or working directory. Every deliverable a judge touches is either in the repo, on the dashboard we deploy ourselves, or on the devnet.
3. **Honesty ledger (§15) is load-bearing.** Every module carries a status tag: `BUILT`, `IN BUILD`, `DESIGNED + STARTED`. Submission materials, the deck, and spoken claims must match the tag at the moment of speaking. Mocked output is labeled as design. The privacy boundary is stated before anyone asks.

---

## 1. What VAJRA is

One sentence: **an Ethereum account that behaves like a bank account — spending limits, cancellable withdrawals, a panic button, a nominee — whose master key is made of hashes instead of curves, so it outranks stolen keys today and survives quantum computers later.**

The account is code (EIP-8141 native account abstraction). The user's existing MetaMask key plugs in as the *daily key* with bounded powers. A hash-based (Winternitz) *master key* on a ₹300 ESP32 outranks it. Master-key operations cost ~4× the public mempool's validation budget and are therefore routable only through the ERC-8421 alternative mempool — which is the project's relationship to the EF track: remove the alt mempool and the product cannot exist.

The thesis that unifies every module, present and future: **every private or post-quantum account is an expensive account.** Hash signatures ≈ 400k gas. Groth16 proof verification ≈ 300k. Native STARK verification ≈ millions. All of it is unroutable under the public mempool's ~100k validation ceiling and native on the alt mempool. VAJRA is the staircase built on that fact:

```
Step 1  BUILT        hash-based spending that outranks stolen keys        (~400k gas)
Step 2  IN BUILD     ERC-8441 stealth + Lamport spending + paymaster      (~400k gas + paymaster frame)
Step 3a IN BUILD     STARK recovery: prove key ownership, reveal nothing  (~300k wrapped / millions native)
Step 3b IN BUILD     shielded notes: hidden balances, proofs in validation (~300k wrapped / millions native)
```

---

## 2. System architecture

```
                         USER
          ┌───────────────┼───────────────────┐
          │               │                   │
   MetaMask (daily    ESP32 "vajra stone"  Dashboard + scanner
   key, unchanged)    WOTS master key,     (Next.js; ALL reads via
          │           OLED, veto button    Anon-RPC)
          │               │ serial/HTTPS       │
          └───────┬───────┴───────────────────┘
                  ▼
        TX BUILDER (TypeScript)
        frame txs (type 0x06): validation frame · paymaster frame · execution frame
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
   public mempool       ERC-8421 ALT MEMPOOL (sidecar bundler)
   (daily path,         (master-key path: escape, veto, rotation,
   ≤100k validation)    stealth spends, STARK recovery, shielded spends)
                  │
                  ▼
        VajraAccount.sol  ── factory ── counterfactual stealth accounts
        ├─ dual-path validation (§3)
        ├─ rulebook state (§4)
        ├─ WOTS verifier (§5)
        ├─ recovery module (§9, STARK)
        └─ shielded pool (§10)
        + ERC-5564 announcer · ERC-6538 registry (stock, §8)
        + SponsorPaymaster.sol (§8.4)
```

---

## 3. Module A — the dual-path account `BUILT (core) / IN BUILD (polish)`

**Storage (ERC-7201 namespaced):**
- `dailyKey` (address) — the user's existing EOA address.
- `wotsRoot` (bytes32) — Merkle root of the current 64-leaf WOTS key tree.
- `leafUsed` — tracked via the devnet's **keyed nonces**: nonce key = leaf index. A reused leaf is unmineable by the protocol itself, independent of our code.
- `epochSalt` (bytes32) — devnet genesis hash, mixed into every signed digest. Kills cross-reset replay.
- Rulebook state (§4), recovery state (§9), pool state (§10).

**Validation frame logic, in order:**
1. Recover the signature type from the frame payload (daily ECDSA vs master WOTS vs recovery proof vs shielded proof).
2. Daily path: ecrecover → must equal `dailyKey` → rulebook checks (§4) → if all pass, validate at <100k gas (public-mempool routable).
3. Master path: WOTS verify (§5) against `wotsRoot` + leaf index as keyed nonce → grants privileged ops: veto, freeze/unfreeze, escape, root rotation, rule changes.
4. **Priority rule (the moat):** no daily-path operation may modify the harbor, the rulebook bounds, `wotsRoot`, or any queued-item state other than *creating* queue entries. Enforced structurally: those storage slots are only writable in master-path or recovery-path code.

**Refusal registry (consolidated):** `DailyLimitExceeded` · `NewPayeeCoolingActive` · `QueuedPendingTimelock` · `VetoedByEscapeKey` · `AccountFrozen` · `HarborImmutable` · `EscapeKeyOutranks` · `LeafAlreadySpent` (device + keyed nonce) · `TreeExhausted` · `ChainStateUnknown` (post-reset root mismatch; unknown is a tier, never a zero) · `MandateUnresolvable` · §9: `RecoveryProofInvalid` · `RecoveryVetoed` · `NullifierSpent` · §10: `ShieldProofInvalid` · `RootUnknown` · `ValueNotConserved`.

---

## 4. Module B — the rulebook `BUILT (limit, queue, veto, escape) / IN BUILD (cooling, freeze) / DESIGNED (nominee)`

Each rule is one validation check plus bounded state. All thresholds are set at account creation or changed only by the master key.

1. **Daily limit.** Rolling 24h accumulator per asset. Daily key spends under it freely. Over it → the transaction is not rejected, it is **queued** (below).
2. **New-payee cooling.** `firstSeen[recipient]` timestamp; transfers to a recipient first seen <24h ago are capped at the cooling allowance regardless of the daily limit's remaining headroom. Kills the drainer's fresh-address hop.
3. **Public queue + veto.** Above-limit intents are stored (`QueuedItem {recipient, asset, amount, executeAfter}`), emit an event, and execute only after 24h. The ESP32 polls and displays the countdown. Master key cancels (`VetoedByEscapeKey`) or, for intended large moves, the owner simply lets it mature. The design inverts detection: the user never needs to notice the theft; the theft must announce itself and wait.
4. **Freeze.** One master-key op sets `frozen=true`: every daily-path validation refuses (`AccountFrozen`) until unfrozen. The "stop the world and think" button.
5. **Escape.** Master-key op that sweeps all configured assets to the **harbor**. The harbor is stored as `keccak256(harborAddress ‖ salt)` at creation (§7 privacy); the escape transaction reveals `(harborAddress, salt)`, the account checks the hash, then sweeps. The daily key cannot change the commitment (`HarborImmutable`), cannot cancel an escape in flight, and loses every race by the priority rule.
6. **Nominee.** `nominee` claim key + `inactivityPeriod` (e.g., 6 months since last daily-key use) + veto window: the nominee's claim queues for 30 days during which the master key can cancel. Indian bank accounts have this field; wallets don't.

---

## 5. Module C — the WOTS cryptography `BUILT`

- **Scheme:** Winternitz one-time signatures, w=256, over keccak256. 32 message chains + 3 checksum chains = 35 chains. Private key: 35 × 32B chain seeds (derived from the device master seed via keccak(seed ‖ leafIndex ‖ chainIndex)). Public key: keccak of the 35 chain tops (each seed hashed 255 times). Signature: 35 × 32B = **1,120 bytes**, each chain advanced to the depth of its digest byte; verification advances every chain to the top (~4,500 keccaks) and recomputes the leaf pubkey.
- **Tree:** 64 leaves, depth-6 Merkle (keccak). Account stores only the root. A signature carries: leaf index, 1,120B WOTS sig, 6×32B Merkle path.
- **Digest binding:** `digest = keccak(chainId ‖ epochSalt ‖ accountAddr ‖ nonceKey ‖ frameTxHash)`. The epoch salt kills devnet-reset replay; the account address kills cross-account replay; the keyed nonce kills same-leaf replay.
- **One-time discipline, three layers:** device marks a leaf spent **at broadcast** (a reorged or unmined tx has still revealed chain values) · keyed nonce on-chain · (stretch) the public Arkiv spent-leaf registry any second device must read before signing.
- **Lifecycle:** leaf 64 reserved for root rotation; exhaustion refuses with `TreeExhausted` until rotation; rotation = master-path op installing a new root signed by the reserved leaf.
- **Security numbers (memorize):** classical preimage 2²⁵⁶; Grover 2¹²⁸; no Shor analogue for hashes. Multi-target discount across our ~2¹⁹ chain positions leaves ≥2¹⁰⁹-equivalent — production schemes (WOTS+/XMSS tweaked hashing) close even that, and we say so rather than hide it.
- **Measured gas is a deliverable:** publish the real validation-gas table (target ≈ 300–450k) against the ~100k public budget. Never quote the estimate once the measurement exists.

---

## 6. Module D — hardware `BUILT (ESP32) / STRETCH (Uno)`

- **ESP32 (30-pin, CP2102):** master seed in NVS (production: flash encryption + secure boot; honest limit stated), WOTS keygen/sign on-device, OLED (SSD1306, SDA→21 SCL→22) states: idle budget ticker · `PENDING: amount → addr, executes in Xh — press to veto` · `REFUSED: leaf N already revealed` · `TREE EXHAUSTED — rotate`. BOOT button (GPIO0) = confirm/veto. HTTPS polling every ~2s (venue WiFi beats WebSocket drops).
- **What-you-see-is-what-you-sign:** the device renders and signs only the structured summary `(amount, recipient, leafIndex, opType)`; the account enforces that digest shape, so a compromised bridge cannot swap payloads behind the screen.
- **Arduino Uno act two (stretch):** signing moves behind one serial cable to a chip with **no radio silicon on the die**. WOTS is pure hashing; an ATmega328 signs in ~1–2s, streaming the 1,120B signature in chunks (2KB RAM). Cut the cable and the key is unreachable by any network on earth. Cut without regret if Friday is tight.

---

## 7. Module E — privacy layer, present tense `BUILT`

- **Committed harbor (Zcash's commitment idea, one hash):** the chain holds `H(harbor ‖ salt)`, revealed only at escape. Nobody can map VAJRA users' exits in advance and lay traps.
- **Anon-RPC everywhere:** every read by the device, dashboard, and scanner routes through the EF's Anon-RPC. "Who is protected" and "who is checking their quantum exposure" is surveillance-grade metadata; we don't emit it.
- **The boundary, said first, always:** balances and rules are public in Steps 1–2. Hidden balances are §10, in build, not shipped at the hackathon.

**Module E2 — the exposure scanner `IN BUILD`:** paste an address → has it ever signed? (exposed pubkey = quantum-vulnerable) → verdict + explanation, lookups via Anon-RPC. Batch mode over top-N accounts produces the first public measurement of Ethereum's exposed share since Deloitte's 2021 figure. Pre-register the sample selection in the repo before scanning; `ambiguous` is a tier.

---

## 8. Module F — VAJRA Stealth (Step 2, the track author's request) `IN BUILD`

**Context:** ERC-8441 (merged; ERCs PR #2059, author namnc) = hybrid post-quantum stealth addresses, schemeId 3 of ERC-5564. Payment secret = **ML-KEM-768 shared secret combined with secp256k1 ECDH**. The ERC's own text: spending stays "secp256k1 ECDSA from a plain EOA." The alt mempool's author asked us, in person, to replace that spending with Lamport/WOTS and add a frame-transaction paymaster. This module is that request.

**8.1 Meta-address & announcement (per ERC-8441, reused unchanged):** recipient registers a ~1,250B meta-address (spending material, viewing EC key, ML-KEM-768 encapsulation key) in the stock ERC-6538 registry; each payment emits a ~1,122B ERC-5564 announcement (ephemeral pubkey, ML-KEM ciphertext, view tag). Both contracts deploy to the devnet byte-identical to mainnet — "used unchanged" is part of the pitch.

**8.2 Our substitution — the spending key:**
- Sender: computes payment secret `s` per 8441 (ML-KEM-768 encapsulation to the recipient's KEM key, combined with ECDH). **Off-chain, in JS — `@noble/post-quantum` implements ML-KEM-768** (pin the version; verify on npm).
- Derivation (our delta): `wotsSeed = keccak(s ‖ "vajra-stealth-v1")` → 64-leaf WOTS tree → `root` → **stealth address = counterfactual VajraAccount** = `CREATE2(factory, salt=root, initcodeHash)`. Sender funds it with USDC and announces.
- Recipient: scans announcements (view tag filter), decapsulates with the KEM secret key, recomputes `s` → seed → root → address; detects funds.
- Spend: first spend deploys the account via factory (deploy frame) and validates with a WOTS leaf — **spending is now post-quantum.**

**8.3 Why this is nearly free:** the lattice math never touches the chain. On-chain is our existing verifier + stock announcer/registry + the paymaster. The genuinely new work is off-chain derivation plumbing and the paymaster frame in the tx encoder.

**8.4 SponsorPaymaster.sol:** a frame-transaction paymaster that pays gas for valid VAJRA stealth spends (naive sponsor-all on devnet; production: fee skimmed from the transferred USDC). This answers the ERC's real UX hole: a fresh stealth address holds USDC and zero ETH. With the paymaster, **the recipient never needs ETH at all.**

**8.5 Hackathon scope cut:** CLI sender/recipient (no scanning UI), hardcoded meta-address, one end-to-end payment: announce → detect → deploy-on-spend → WOTS-validated, paymaster-funded transfer, admitted via the alt mempool. If the core rail isn't live, this ships as design-only (§15 tags govern what is claimed).

**8.6 The loop-closer for the author:** "You asked for Lamport spending on 8441 with a paymaster. Here's a stealth payment received at an unlinkable address, spent with a hash signature, gas paid by the paymaster, zero ETH on the address, admitted through your mempool." Open question for him: cleanest digest format binding the WOTS root into the 8441 derivation.

---

## 9. Module G — STARK recovery (Step 3a) `IN BUILD — design complete, implementation started, not shipping by Nov 7`

**What it is, plainly:** a recovery path where the user proves "I know the recovery secret" with a zero-knowledge proof instead of revealing the secret. The account verifies the proof and installs a new WOTS root. Nobody — not the mempool, not a quantum-equipped front-runner, not us — ever sees the secret. This is the approach Vitalik sketched in "How to hard-fork to save most users' funds in a quantum emergency" (ethresear.ch, Mar 2024): STARK-prove knowledge of a hash-derived preimage. We implement it per-account, in advance, calmly — the fire drill to his fire brigade.

**9.1 Why a proof instead of revealing the secret:** reveal-based recovery puts the secret in the public mempool, where anyone (classically a front-runner, later a quantum attacker) can race you with their own rotation using your just-revealed secret. Commit-reveal with a delay fixes ordering but is slow and still burns the secret. A ZK proof exposes nothing, binds the new root into the statement so the proof is useless to a thief, and leaves the secret reusable. And because STARKs are built from hashes, the proof system itself is post-quantum-aligned — the recovery path stays as strong as the key it replaces.

**9.2 Setup (at account creation):** store `recoveryCommitment = keccak(recoverySecret)` (the secret: 32 bytes on paper/steel, in the user's locker — deliberately offline), plus `recoveryDelay` (48h) and the master key's veto right during the delay.

**9.3 The statement (the zkVM program proves):**
- Private input: `recoverySecret`.
- Public outputs (the journal): `recoveryCommitment` — recomputed as `keccak(recoverySecret)` and matched against account storage; `newWotsRoot` — bound into the proof so it cannot be replayed to install an attacker's root; `accountAddr` and `epochSalt` — scoping; `nullifier = keccak(recoverySecret ‖ accountAddr ‖ "recovery-nullifier")` — recorded on first use so one proof cannot be submitted twice (`NullifierSpent`).

**9.4 Flow:** user runs the prover locally (seconds-to-minutes on a laptop) → submits a recovery frame tx carrying the proof → account verifies, checks commitment + nullifier, queues `newWotsRoot` for `recoveryDelay` → master key may veto (`RecoveryVetoed` — a stolen recovery paper can't instantly take the account) → delay matures → root installs. Verification cost is far above 100k either way, so **recovery is only routable on the alt mempool — the staircase's step three riding the same track.**

**9.5 Toolchain decision (honest trade-offs):**

| Route | What it is | On-chain verify | PQ-pure? | Effort |
|---|---|---|---|---|
| RISC Zero / SP1 zkVM | write the statement in Rust, get a receipt | their EVM verifier wraps the STARK in **Groth16** (~300k gas) | **No** — the wrapper adds a pairing assumption; say so | ~2–4 weeks to solid |
| Native STARK verify on-chain | verify the hash-based proof directly | **millions of gas** | **Yes** | heavy; the research edge |
| Cairo/Stone, Winterfell, plonky3 | lower-level STARK stacks | varies | yes (hash-based) | more manual |

**Phasing:** v1 = zkVM + Groth16-wrapped verifier (works, cheap enough, honestly labeled "proof system not yet PQ-pure"); v2 = native on-chain STARK verification — the most expensive validation ever routed, which is not a bug but the whole alt-mempool thesis said loudly. **Status for Nov 7: statement spec + repo scaffolding + this design committed; no proof claimed.**

---

## 10. Module H — shielded notes (Step 3b) `IN BUILD — design complete, implementation started, not shipping by Nov 7`

**What it is, plainly:** the Zcash-style endgame. Money inside the account becomes **notes** — sealed envelopes only the owner can open. The chain sees that *a* valid spend happened, never the amounts or the links. The proof that a spend is honest is checked **inside account validation** (8141), which makes a shielded account an expensive account, which makes it alt-mempool-native.

**10.1 The scheme (commitment/nullifier, Zcash lineage):**
- A note = `commitment = PoseidonHash(value, ownerKey, rho, randomness)`. Commitments live in an append-only Merkle tree (depth 20, Poseidon — the ZK-friendly hash; note honestly that Poseidon is younger cryptanalytically than keccak).
- Spending a note reveals its `nullifier = PoseidonHash(rho, ownerKey)` — a one-time serial number unlinkable to the commitment. The nullifier set prevents double-spends (`NullifierSpent`); the tree membership proof never reveals *which* leaf was spent.
- **Shield:** deposit USDC → new commitment appended (amount visible on entry — stated honestly; privacy grows with the pool). **Shielded transfer:** proof consumes notes, creates new ones; outsiders see nothing but "a valid state change." **Unshield:** proof releases value to a public address (amount visible on exit).

**10.2 The circuit statement:** I know notes `(n₁…nₖ)` and Merkle paths to a recent root; their nullifiers are `(N₁…Nₖ)`, correctly computed and unspent; output commitments `(c₁…cₘ)` are well-formed; `Σ inputs = Σ outputs + publicWithdrawal`; all values in range. Refusals: `ShieldProofInvalid`, `RootUnknown` (stale root is a tier, not an error), `ValueNotConserved`, `NullifierSpent`.

**10.3 The integrations that make it ours, not a Tornado clone:**
- **Note delivery rides Module F:** the encrypted note plaintext (value, rho, randomness) travels to the recipient inside an ERC-8441-style announcement — **ML-KEM-encrypted, so even the envelope's delivery is post-quantum.** Stealth receiving and shielded holding become one flow.
- **Viewing key** derived from the device master seed: the owner (or an auditor they choose) can decrypt their own history — privacy with an owner-controlled disclosure path, not a black hole.
- **The master key governs the pool:** escape can unshield-everything-to-harbor; freeze halts shielded spends; the rulebook's limits can apply to unshielding. The bank-account rules survive inside the shielded world.
- **PQ nuance, stated plainly:** v1 proofs (Groth16/Plonk via zkVM route) rely on pairings — not PQ. The PQ-pure version is STARK-proven, which lands at millions of verification gas — again, only routable on the alt mempool. The privacy endgame and the PQ endgame converge on the same proof system and the same track. That convergence **is** the staircase.

**10.4 Phasing:** v1 single-asset (USDC) pool inside VajraAccount, zkVM-generated proofs, wrapped verifier; v2 arbitrary assets + native STARK verification. **Status for Nov 7: circuit statement + pool storage design + this document committed; no working proofs claimed.**

---

## 11. The staircase, assembled

| Step | What the user gets | Validation cost | Status |
|---|---|---|---|
| 1 | Rules a stolen key can't break; quantum-proof master key | ~400k (WOTS) | BUILT |
| 2 | Paid secretly, spend quantum-safely, no ETH ever | ~400k + paymaster | IN BUILD |
| 3a | Recover everything by proving, not revealing | ~300k wrapped → millions native | IN BUILD (design + start) |
| 3b | Balances nobody can see, rules that still hold | ~300k wrapped → millions native | IN BUILD (design + start) |

One sentence for the track's author: "Every private account is an expensive account — your mempool isn't just carrying our quantum wallet, it's where account-level privacy becomes routable at all. We're step one, you asked for step two, and this document is steps three and four."

---

## 12. Threat model additions for Steps 2–3 (extends 03-VAJRA-SPEC §11)

- **Stealth (F):** announcement spam/scanning DoS → view tags (per 8441) + client-side filtering. Sender-side secret `s` must be erased post-send (sender can otherwise compute the recipient's spending seed — inherent to 8441's model; note it). Paymaster drain → per-address sponsorship caps + only sponsoring VAJRA-validated spends.
- **STARK recovery (G):** proof replay → nullifier + newRoot binding. Stolen recovery paper → delay + master-key veto window. Prover toolchain compromise → reproducible builds, pinned verifier hash. Groth16 wrapper → trusted-setup/pairing assumptions inherited and disclosed until v2.
- **Shielded pool (H):** double-spend → nullifier set. Stale/forked roots → recent-roots ring buffer, `RootUnknown` as a tier. Value forgery → conservation + range constraints in-circuit. Small-anonymity-set deanonymization early on → documented honestly; fixed denominations considered for v1. Poseidon cryptanalysis risk → parameter review before anything holds real value.
- **Everything:** proofs and signatures bind `chainId ‖ epochSalt ‖ accountAddr`; unknown state always refuses as its own named tier; no module ever renders unknown as zero.

---

## 13. Build plan by dependency (no calendar pressure in this file; 03 governs the deadline)

- **Phase 1 — core rail** (Step 1): WOTS verifier → measured gas table → first admitted tx → dual-path + rulebook → device. *Everything below depends on this.*
- **Phase 2 — stealth** (Step 2): announcer/registry deploy → noble ML-KEM derivation CLI → counterfactual deploy-on-spend → SponsorPaymaster → one end-to-end payment. ~5–7 focused hours on a working Phase 1.
- **Phase 3 — STARK recovery** (Step 3a): statement spec (done, §9.3) → zkVM prototype (RISC Zero or SP1) → wrapped verifier integration → delay/veto wiring → measured verification gas. ~2–4 weeks of real work; begins now, ships after the hackathon.
- **Phase 4 — shielded pool** (Step 3b): circuit (done as spec, §10.2) → Poseidon tree + nullifier set contracts → zkVM proofs → note delivery over Module F's announcements → viewing keys. ~4–8 weeks; begins now.
- **Phase 5 — hardening:** LMS/XMSS/SPHINCS+ swap, secure element, PIN, formal verification of the WOTS verifier (pure function, no external calls — the easy proof target; Certora/Kontrol for rules, Lean for machine-checked, per the S-two precedent), native STARK verification replacing the Groth16 wrapper.

---

## 14. Q&A pack (the questions this document must survive)

- *"Is step 3 built?"* — "Designed in full, implementation started, and we will not claim a working proof until one exists. This document is the design; the repo shows where the code stands today."
- *"Why is your recovery PQ story using Groth16?"* — "v1 pragmatism, disclosed: the zkVM's EVM verifier wraps the STARK in Groth16. v2 is native STARK verification — millions of gas, which is exactly the kind of validation only the alt mempool can route. The limitation is labeled in §9.5."
- *"Isn't a shielded pool just Tornado?"* — "Tornado is fixed-denomination mixing with no owner rules. Ours is a note system inside an account that keeps its rulebook: limits, freeze, escape, and an owner-held viewing key. Privacy with a steering wheel."
- *"Why should the alt mempool care about privacy modules?"* — the §11 sentence, verbatim.
- *"What stops a thief with the recovery paper?"* — "48 hours of delay and a master-key veto. Stealing the paper starts a countdown on the victim's desk, same philosophy as the queue."

---

## 15. Honesty ledger (what may be claimed, when)

| Module | Tag | May claim at submission |
|---|---|---|
| Dual-path account, rulebook core, WOTS, device | BUILT* | whatever has tx IDs / runs live (*tags flip only on working demos) |
| Cooling, freeze, scanner | IN BUILD | "building, demo if done" |
| Stealth (F) | IN BUILD | working payment OR "the track author's request, designed overnight" — never a mocked run |
| STARK recovery (G) | IN BUILD (design + start) | design + started; **no proof claimed** |
| Shielded notes (H) | IN BUILD (design + start) | design + started; **no hidden balances claimed; boundary said first** |
| Nominee, Uno, Arkiv registry | STRETCH | only if working |

Standing rules repeated once because they are cheap to repeat and expensive to break: push without co-author; never create artifacts; mocked output is labeled design; the measured number replaces the estimate the moment it exists; the privacy boundary is spoken before anyone asks.
