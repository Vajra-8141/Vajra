/**
 * Proofs in the browser. The secret goes into the prover here and never leaves this device; only the proof does.
 * The same statements as packages/cli/src/proving.ts, with a small Poseidon, since that file reads from disk.
 */
import { poseidon1, poseidon2 } from "poseidon-lite";
import { type Address, type Hex, bytesToHex } from "viem";
import type { FlatProof } from "@vajra/core";
import zeros from "../../../../packages/core/src/pool-zeros.json" with { type: "json" };

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LIMB = 1n << 128n;
const POOL_DEPTH = 20;
const limbs = (value: Hex): [bigint, bigint] => [BigInt(value) / LIMB, BigInt(value) % LIMB];

interface Snark {
  groth16: { fullProve(input: unknown, wasm: unknown, zkey: unknown): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }> };
}
/** The browser loads snarkjs from a script tag, and the test sets the same global. */
const snark = () => (globalThis as unknown as { snarkjs: Snark }).snarkjs;
/** Where the circuit files are: a URL in the browser, a path in the test. */
export const zk = { base: "/zk/" };

const flatten = (p: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): FlatProof =>
  [p.pi_a[0], p.pi_a[1], p.pi_b[0]![1], p.pi_b[0]![0], p.pi_b[1]![1], p.pi_b[1]![0], p.pi_c[0], p.pi_c[1]].map((v) => BigInt(v!)) as unknown as FlatProof;

export const randomFieldElement = (): bigint => BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(31))));

const prove = async (circuit: string, input: Record<string, unknown>) => {
  const { proof } = await snark().groth16.fullProve(input, `${zk.base}${circuit}.wasm`, `${zk.base}${circuit}.zkey`);
  return flatten(proof);
};

export const recoveryCommitment = (secret: bigint) => poseidon1([secret]);
const recoveryNullifier = (secret: bigint, account: Address) => poseidon2([secret, BigInt(account)]);

export async function proveRecovery(s: { secret: bigint; newRoot: Hex; account: Address; epochSalt: Hex; chainId: number }) {
  const [rootHi, rootLo] = limbs(s.newRoot);
  const [saltHi, saltLo] = limbs(s.epochSalt);
  const nullifier = recoveryNullifier(s.secret, s.account);
  const proof = await prove("recovery", {
    s: s.secret,
    recoveryCommitment: recoveryCommitment(s.secret),
    newWotsRootHi: rootHi,
    newWotsRootLo: rootLo,
    accountAddr: BigInt(s.account),
    epochSaltHi: saltHi,
    epochSaltLo: saltLo,
    chainId: BigInt(s.chainId),
    nullifier,
  });
  return { proof, nullifier };
}

export interface PoolNote {
  secret: bigint;
  nullifierSeed: bigint;
}
export const newNote = (): PoolNote => ({ secret: randomFieldElement(), nullifierSeed: randomFieldElement() });
export const noteCommitment = (n: PoolNote) => poseidon2([n.secret, n.nullifierSeed]);
const noteNullifier = (n: PoolNote) => poseidon1([n.nullifierSeed]);

function poolPath(leaves: bigint[], leaf: number) {
  let level = leaves;
  let index = leaf;
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  for (let depth = 0; depth < POOL_DEPTH; depth++) {
    const zero = BigInt((zeros as string[])[depth]!);
    pathElements.push(level[index ^ 1] ?? zero);
    pathIndices.push(index & 1);
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(poseidon2([level[i]!, level[i + 1] ?? zero]));
    level = next;
    index >>= 1;
  }
  return { root: level[0]!, pathElements, pathIndices };
}

export async function proveUnshield(s: { note: PoolNote; leaves: bigint[]; leaf: number; recipient: Address; denomination: bigint; account: Address; chainId: number }) {
  const { root, pathElements, pathIndices } = poolPath(s.leaves, s.leaf);
  const nullifierHash = noteNullifier(s.note);
  const proof = await prove("unshield", {
    secret: s.note.secret,
    nullifierSeed: s.note.nullifierSeed,
    pathElements,
    pathIndices,
    root,
    nullifierHash,
    recipient: BigInt(s.recipient),
    denomination: s.denomination,
    accountAddr: BigInt(s.account),
    chainId: BigInt(s.chainId),
  });
  return { proof, root, nullifierHash };
}
