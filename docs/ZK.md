# Recovery by proof, and the shielded pool

Both run on the local mirror only, never on the public devnet. [`JUDGES.md`](../JUDGES.md) has the commands.

## Say this first

- **Groth16 is not post-quantum.** It rests on pairings over BN254, which a quantum computer breaks. The master key is made of
  hashes, and the recovery path that can replace it is not. Spec 04 called v1 "not yet PQ-pure", and that is what this is. v2 is a
  STARK verified in the account. It is not built.
- **The trusted setup has one contributor.** Phase 1 is PSE's perpetual powers of tau, 80 contributions, pinned by hash. Phase 2 was
  run once, by us, in `circuits/scripts/build.sh`. Whoever ran it could have kept the entropy, and with it could forge any proof in
  either circuit. The script discards it, but nothing proves that. A real deployment needs a phase 2 ceremony.
- **The anonymity set starts tiny.** It is the notes in one account's pool. On day one that is a handful.
- **The pool does not cut the owner's link to a recipient.** See [what the pool hides](#what-the-pool-hides). This is the limit that
  matters most.
- **Poseidon is younger than keccak.** It has had far less cryptanalysis.
- **None of this has been audited.**

## Where it runs, and why

`contracts/src/VajraAccount.sol` is what is deployed on the public devnet, and it is unchanged. New code lives in
`contracts/src/VajraAccountV2.sol`, a copy with every difference marked `V2:`. It had to be a copy: recovery goes through
`executeQueued`, and the pool has to reach into `spend`, `escape` and `validateDaily`, none of which are virtual.
`VajraAccountV2Parity.t.sol` runs all 48 rulebook tests against V2. V2 also carries one fix the deployed contract lacks: see `FINDINGS.md` section 8.

A pairing check cannot pass the deployed sidecar. The same transaction, byte for byte, from a staked account, on the same chain
(`vajra compare`, recorded in `docs/evidence/compare-latest.json`):

    sidecar as deployed:  validation prefix execution gas sum 500000 + signature-verification cost 0 = 500000 exceeds MAX_VERIFY_GAS 100000
    canonical mempool:    Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS
    sidecar with the patch:  mined

The patch restores what ERC-8421 already says: BUDGET-010's staked budget and CALLING-040's precompiles.

## A proof is not a signature

This shaped both designs more than anything else. A transaction authorized by a proof has no signature, so nothing commits to its
frames or its fee, and anyone who sees it in a mempool can resend it changed. `sender_approved` covers every SENDER frame, so a copy
with one more frame paying the attacker would run with the account's authority.

So `_requireProofShape` pins, in VERIFY, what a signature would have committed to: exactly `[VERIFY, SENDER]`, the SENDER frame being
this account calling this function with no value, exactly the arguments the proof is checked against, and exactly the gas it needs, a
nonce key derived from the nullifier and what the proof installs or pays, and a cap on what the transaction can cost. Each is tested on its
own, because any one left open is an attack.

The gas is pinned because a mined failure is permanent. A copy with too little gas would pass the proof, spend the nonce and fail in the SENDER
frame, and the nullifier's nonce key could never be used again. That attack worked against the first version: see `FINDINGS.md` section 8.

The nonce key means a retry is the identical bytes, and that a thief's pending daily transaction cannot hold a recovery up on a
mempool that keeps the two nonce domains apart. That is the same reason an escape uses one. It includes the recipient, so if a recipient
reverts, the note is not spent and a fresh proof to another address still works.

## Recovery

The statement, in `circuits/src/recovery.circom`: I know `s` where `Poseidon(s)` is this account's commitment, and I am installing this
root, on this account, under this salt, on this chain. The nullifier is `Poseidon(s, account)`. Only `s` is private.

    fresh account → recover-setup → master key lost → recover-prove → recover → veto window → anyone installs → new tree signs

- The new root goes into the same queue as a spend, so `veto` cancels it and `executeQueued` installs it.
- **A freeze does not stop a recovery.** Freeze stops spending, and an owner who lost the master key cannot unfreeze.
- **A secret gets one attempt per account.** The nullifier is spent when the root is queued, even if it is then vetoed. So a thief with
  a stolen paper gets one try and the owner a veto, and after that the owner, who still has the master key, sets a new commitment.
- **If the master key is lost and the paper is stolen, the thief wins.** Nothing can tell them apart. The veto only helps an owner who
  still has the master key.
- The daily key cannot reach any of this: `validateDaily` allows neither selector.

Two details in the circuit that are easy to get wrong. A 256-bit root does not fit in the BN254 field, and the verifier refuses an
input that does not fit, so the root and salt go in as 128-bit limbs. And a public input that appears in no constraint has a zero
point in the verifying key, so any value would pass: the squares at the end of each circuit are what make the proof commit to those
values. Attacks that change each one are in `vajra recover`.

## The shielded pool

Fixed denomination, ETH, inside the account. On the mirror a note is 0.1 ETH, and 0.095 ETH reaches the recipient: the rest is the note's fee,
and what its transaction does not spend stays with the account. A note is `Poseidon(secret, nullifierSeed)` in a depth-20 Poseidon tree, and the
withdrawal circuit proves membership without saying which leaf.

**The rulebook survives inside the pool:**

| Rule | How |
|---|---|
| A freeze stops an unshield | checked in VERIFY, so it never reaches a mempool, and again in the SENDER frame |
| A freeze stops a deposit | `shield` refuses |
| An escape drains the pool to the sealed harbor | the sweep takes the whole balance, then the pool closes for good, so an old note cannot claim money that arrives later |
| The daily key cannot touch it | neither selector is allowed, and a daily frame cannot carry value |
| A spend cannot reach into the notes | `_transfer` keeps `poolHeld` out of reach, even of a spend inside the limit |
| Fees cannot eat the notes | a note pays its own fee, out of its value. A daily transaction or a recovery needs the balance to cover the notes and the fee. A staked sender may read its balance in validation, so an account with a pool must be staked |
| Nobody can use the pool to burn the owner's money | since a note pays its own way, a shield-and-unshield loop costs whoever runs it |
| Only the owner opens a pool | the first note has to come from the account, so an outsider cannot switch the balance check on for an unstaked account |

**The root ring is 32 deep.** A proof takes time to reach a block, and the tree moves under it. The EF's guidance is that validity
resting on fast-changing state leaks reputation, so an unshield may prove against any of the last 32 roots. A root that has left the
ring gets `RootUnknown`, which is a tier, not an error: the note is fine, and `vajra unshield` proves again. A retry of the same proof
is the same bytes. `vajra shielded` tests both sides of the edge: mined 30 deposits behind, refused 33 behind.

**The master key can take the pool.** That is the point of a pool that obeys the rulebook, and it also means this is not trustless: a
note in someone else's pool is only as good as that account's master key, and anyone paying in should know it.

### What the pool hides

An unshield is a transaction from the account, to a public recipient, for a public amount. So the chain still shows that this account
paid that recipient. **The pool does not hide that.** What it hides is which note paid, and so which deposit, among everyone who has
paid into this account's pool. Outside depositors get real unlinkability from their deposit to the withdrawal, inside a small set. The
owner shielding their own balance gets almost none.

This follows from the pool being inside the account, which is also what lets freeze and escape govern it. A pool shared between
accounts would hide much more and could not obey any one account's rulebook. We chose the rulebook, and the design below does not
remove this limit.

## Designed, not built

Each of these is a design in spec 04 §10. **None exists.**

- Variable amounts, and note-to-note transfers. v1 notes are one size, and can only leave.
- Viewing keys. Notes sit in a local file, not derived from the master seed.
- Note delivery over ERC-8441.
- USDC. v1 is ETH.
- STARK verification, for both circuits. That is v2, and it is what would make these paths post-quantum.

## Reproduce

Compiled circuits and keys are committed, so running this needs neither circom nor snarkjs. To rebuild them, which produces a new setup
and needs a new deployment:

    cd circuits && bash scripts/build.sh recovery RecoveryVerifier && bash scripts/build.sh unshield ShieldVerifier
    node scripts/gen-pool-constants.mjs && node scripts/gen-vectors.mjs
