// Real proofs for Foundry, so the contract tests run the generated verifiers on real pairings, not on a mock.
import { readFileSync, writeFileSync } from "node:fs";
import { buildPoseidon, poseidonContract } from "circomlibjs";
import { groth16 } from "snarkjs";

const ACCOUNT = 0xc0ffee0000000000000000000000000000c0ffeen;
const CHAIN = 13370n;
const SALT = BigInt("0x" + "ab".repeat(32));
const NEW_ROOT = BigInt("0x" + "cd".repeat(32));
const DENOM = 10n ** 16n;
const RECIPIENT = 0xbeef00000000000000000000000000000000beefn;
const LIMB = 1n << 128n;

const hash = await buildPoseidon();
const H = (...a) => hash.F.toObject(hash(a));
const zeros = JSON.parse(readFileSync(new URL("../../packages/core/src/pool-zeros.json", import.meta.url), "utf8")).map(BigInt);
const flat = (p) => [p.pi_a[0], p.pi_a[1], p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0], p.pi_c[0], p.pi_c[1]].map(String);
const build = (name, file) => new URL(`../build/${name}/${file}`, import.meta.url).pathname;

const s = 123456789n;
const commitment = H(s);
const nullifier = H(s, ACCOUNT);
const recovery = await groth16.fullProve(
  {
    s,
    recoveryCommitment: commitment,
    newWotsRootHi: NEW_ROOT / LIMB,
    newWotsRootLo: NEW_ROOT % LIMB,
    accountAddr: ACCOUNT,
    epochSaltHi: SALT / LIMB,
    epochSaltLo: SALT % LIMB,
    chainId: CHAIN,
    nullifier,
  },
  build("recovery", "recovery_js/recovery.wasm"),
  build("recovery", "recovery.zkey"),
);

// Two notes, so the proof is for a right child and the path has a real sibling.
const first = H(11n, 22n);
const second = H(33n, 44n);
const pathElements = [first, ...zeros.slice(1, 20)];
const pathIndices = [1, ...Array(19).fill(0)];
let root = H(first, second);
for (let i = 1; i < 20; i++) root = H(root, zeros[i]);
const nullifierHash = H(44n);
const unshield = await groth16.fullProve(
  { secret: 33n, nullifierSeed: 44n, pathElements, pathIndices, root, nullifierHash, recipient: RECIPIENT, denomination: DENOM, accountAddr: ACCOUNT, chainId: CHAIN },
  build("unshield", "unshield_js/unshield.wasm"),
  build("unshield", "unshield.zkey"),
);

writeFileSync(
  new URL("../../contracts/test/vectors/zk.json", import.meta.url),
  JSON.stringify(
    {
      account: "0x" + ACCOUNT.toString(16).padStart(40, "0"),
      recipient: "0x" + RECIPIENT.toString(16).padStart(40, "0"),
      commitment: commitment.toString(),
      nullifier: nullifier.toString(),
      recoveryProof: flat(recovery.proof),
      firstNote: first.toString(),
      secondNote: second.toString(),
      poolRoot: root.toString(),
      nullifierHash: nullifierHash.toString(),
      unshieldProof: flat(unshield.proof),
      poseidon: poseidonContract.createCode(2),
    },
    null,
    1,
  ) + "\n",
);
await globalThis.curve_bn128?.terminate();
console.log("wrote contracts/test/vectors/zk.json");
