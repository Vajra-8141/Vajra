/**
 * The proving spine: every circuit goes through here. Groth16 over BN254, via snarkjs, with the keys in `circuits/build`.
 *
 * Pairing-based, so a quantum computer breaks it. The secret stays on this machine, and everything else in a statement is
 * public. See docs/ZK.md.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { type Proof, groth16 } from "snarkjs";
import { type Address, type Hex, bytesToHex, concat, keccak256, numberToHex, toHex } from "viem";
import type { FlatProof } from "@vajra/core";

/** The BN254 scalar field. A public input at or above this is refused by the verifier. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const LIMB = 1n << 128n;

const zeros = JSON.parse(readFileSync(new URL("../../core/src/pool-zeros.json", import.meta.url), "utf8")) as string[];

export const limbs = (value: Hex): [bigint, bigint] => [BigInt(value) / LIMB, BigInt(value) % LIMB];

const poseidonReady = buildPoseidon();

export async function poseidon(...inputs: bigint[]): Promise<bigint> {
  const hash = await poseidonReady;
  return hash.F.toObject(hash(inputs));
}

/** 31 random bytes are always below the field, and 248 bits is far past what any search can reach. */
export const randomFieldElement = (): bigint => BigInt(bytesToHex(randomBytes(31)));

const artifact = (name: string, file: string) => new URL(`../../../circuits/build/${name}/${file}`, import.meta.url).pathname;

/** snarkjs prints G2 coordinates the other way round from the precompile. */
export const flatten = (p: Proof): FlatProof =>
  [p.pi_a[0], p.pi_a[1], p.pi_b[0]![1], p.pi_b[0]![0], p.pi_b[1]![1], p.pi_b[1]![0], p.pi_c[0], p.pi_c[1]].map((v) => BigInt(v!)) as unknown as FlatProof;

export interface Proved {
  proof: FlatProof;
  publicSignals: string[];
  /** How long the prover took, for the record. */
  ms: number;
}

/** Proves, then checks the proof with the verifying key before anyone pays to have a contract check it. */
export async function prove(circuit: string, input: Record<string, unknown>): Promise<Proved> {
  const started = Date.now();
  const { proof, publicSignals } = await groth16.fullProve(input, artifact(circuit, `${circuit}_js/${circuit}.wasm`), artifact(circuit, `${circuit}.zkey`));
  const ms = Date.now() - started;
  const vkey = JSON.parse(readFileSync(artifact(circuit, "vkey.json"), "utf8"));
  if (!(await groth16.verify(vkey, publicSignals, proof))) throw new Error("the proof does not verify against its own key");
  return { proof: flatten(proof), publicSignals, ms };
}

/** snarkjs leaves worker threads running, and they hold the process open. */
export async function stopProver() {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
}

export interface RecoveryStatement {
  secret: bigint;
  newRoot: Hex;
  account: Address;
  epochSalt: Hex;
  chainId: number;
}

export const recoveryCommitment = (secret: bigint) => poseidon(secret);
export const recoveryNullifier = (secret: bigint, account: Address) => poseidon(secret, BigInt(account));

export async function proveRecovery(s: RecoveryStatement): Promise<Proved & { nullifier: bigint }> {
  const [rootHi, rootLo] = limbs(s.newRoot);
  const [saltHi, saltLo] = limbs(s.epochSalt);
  const nullifier = await recoveryNullifier(s.secret, s.account);
  const proved = await prove("recovery", {
    s: s.secret,
    recoveryCommitment: await recoveryCommitment(s.secret),
    newWotsRootHi: rootHi,
    newWotsRootLo: rootLo,
    accountAddr: BigInt(s.account),
    epochSaltHi: saltHi,
    epochSaltLo: saltLo,
    chainId: BigInt(s.chainId),
    nullifier,
  });
  return { ...proved, nullifier };
}

export const POOL_DEPTH = 20;

export interface Note {
  secret: bigint;
  nullifierSeed: bigint;
}

export const newNote = (): Note => ({ secret: randomFieldElement(), nullifierSeed: randomFieldElement() });
export const noteCommitment = (note: Note) => poseidon(note.secret, note.nullifierSeed);
export const noteNullifier = (note: Note) => poseidon(note.nullifierSeed);

/**
 * Note number `index` of a seed. The account and chain are in the hash, so one seed on two accounts makes notes the chain cannot link.
 * The top 248 bits, because a value at or above the field could never be proven.
 */
export function noteFromSeed(seed: Hex, account: Address, chainId: number, index: number): Note {
  const part = (label: string) => BigInt(keccak256(concat([toHex(label), seed, account, numberToHex(chainId, { size: 32 }), numberToHex(index, { size: 32 })]))) >> 8n;
  return { secret: part("vajra-note-secret"), nullifierSeed: part("vajra-note-nullifier") };
}

/** How many numbers in a row may have no deposit before a rebuild stops looking. A deposit that failed leaves one such gap. */
export const SEED_GAP = 20;

export interface FoundNote {
  note: Note;
  index: number;
  commitment: bigint;
  leaf: number;
}

/** Every note of this seed in `leaves`, the pool's commitments in order. The chain is the only input besides the seed. */
export async function notesInPool(seed: Hex, account: Address, chainId: number, leaves: bigint[], gap = SEED_GAP): Promise<FoundNote[]> {
  const found: FoundNote[] = [];
  for (let index = 0, misses = 0; misses < gap; index++) {
    const note = noteFromSeed(seed, account, chainId, index);
    const commitment = await noteCommitment(note);
    const leaf = leaves.indexOf(commitment);
    if (leaf < 0) {
      misses++;
      continue;
    }
    misses = 0;
    found.push({ note, index, commitment, leaf });
  }
  return found;
}

/** The pool's tree as the contract builds it, rebuilt from its `Shielded` events. Only the filled part is ever hashed. */
export async function poolPath(leaves: bigint[], leaf: number): Promise<{ root: bigint; pathElements: bigint[]; pathIndices: number[] }> {
  if (leaf >= leaves.length) throw new Error(`leaf ${leaf} is not in a tree of ${leaves.length}`);
  let level = leaves;
  let index = leaf;
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  for (let depth = 0; depth < POOL_DEPTH; depth++) {
    const zero = BigInt(zeros[depth]!);
    pathElements.push(level[index ^ 1] ?? zero);
    pathIndices.push(index & 1);
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await poseidon(level[i]!, level[i + 1] ?? zero));
    level = next;
    index >>= 1;
  }
  return { root: level[0]!, pathElements, pathIndices };
}

export interface UnshieldStatement {
  note: Note;
  leaves: bigint[];
  leaf: number;
  recipient: Address;
  denomination: bigint;
  account: Address;
  chainId: number;
}

export async function proveUnshield(s: UnshieldStatement): Promise<Proved & { root: bigint; nullifierHash: bigint }> {
  const { root, pathElements, pathIndices } = await poolPath(s.leaves, s.leaf);
  const nullifierHash = await noteNullifier(s.note);
  const proved = await prove("unshield", {
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
  return { ...proved, root, nullifierHash };
}
