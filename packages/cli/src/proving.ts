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
import { type Address, type Hex, bytesToHex } from "viem";
import type { FlatProof } from "@vajra/core";

/** The BN254 scalar field. A public input at or above this is refused by the verifier. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const LIMB = 1n << 128n;

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
