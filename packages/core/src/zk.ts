/**
 * Transactions authorized by a proof instead of a signature. These run on the local mirror only: the pairing check costs more
 * than the deployed sidecar's flat cap, and uses precompiles it refuses.
 *
 * The contract pins everything a signature would have committed to, so these builders have to produce exactly that shape:
 * see `_requireProofShape` in VajraAccountV2.
 */
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, concat, decodeErrorResult, encodeAbiParameters, encodeFunctionData, hexToBytes, keccak256, numberToHex, parseAbiParameters, toBytes, toHex } from "viem";
import { deployments } from "./account.ts";
import { DEVNET } from "./devnet.ts";
import { type Call, type Fees, type FrameTx, DEFAULT_FEES, profile } from "./frame.ts";
import VajraAccountV2 from "./artifacts/VajraAccountV2.json" with { type: "json" };

export const accountV2Abi = VajraAccountV2.abi;

/** Groth16 `a`, `b`, `c`, flattened in the order the verifier takes them. */
export type FlatProof = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

/** A staked sender's budget is 1,000,000 under BUDGET-010. This is the limit declared, not the gas used. */
export const PROOF_VERIFY_GAS = 500_000n;

const RECOVERY_TAG = keccak256(toBytes("vajra.recovery.v1"));
const UNSHIELD_TAG = keccak256(toBytes("vajra.unshield.v1"));

const word = (value: bigint) => numberToHex(value, { size: 32 });

export const recoveryNonceKey = (nullifier: bigint, newRoot: Hex): bigint => BigInt(keccak256(concat([RECOVERY_TAG, word(nullifier), newRoot])));

/** The nullifier alone, so that a note has one slot however many proofs its holder makes. */
export const unshieldNonceKey = (nullifierHash: bigint): bigint => BigInt(keccak256(concat([UNSHIELD_TAG, word(nullifierHash)])));

/** The key the contract first used, with the recipient in it. Only `vajra proof-spam` still needs this. */
export const preFixUnshieldNonceKey = (nullifierHash: bigint, recipient: Address): bigint =>
  BigInt(keccak256(concat([UNSHIELD_TAG, word(nullifierHash), numberToHex(BigInt(recipient), { size: 32 })])));

const encode = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: accountV2Abi, functionName, args });

/** Exactly what `_requireProofShape` demands of the SENDER frame. These are pinned on chain, so changing one here is not enough. */
export const PROOF_FRAME_GAS = {
  recovery: { execution: 200_000n, state: 800_000n },
  unshield: { execution: 500_000n, state: 600_000n },
} as const;

export const SHIELD_EXECUTION_GAS = 2_500_000n;
export const SHIELD_STATE_GAS = 3_000_000n;

export const opsV2 = {
  setExit: (exit: Address): Call => ({ data: encode("setExit", [exit]), execution: 60_000n, state: 100_000n }),
  setSponsor: (paymaster: Address, allowed = true): Call => ({ data: encode("setSponsor", [paymaster, allowed]), execution: 60_000n, state: 100_000n }),
  setRecovery: (commitment: bigint, delay: bigint, gate: Hex): Call => ({ data: encode("setRecovery", [commitment, delay, gate]), execution: 80_000n, state: 300_000n }),
  queueRecovery: (root: Hex, nullifier: bigint): Call => ({ data: encode("queueRecovery", [root, nullifier]), ...PROOF_FRAME_GAS.recovery }),
  // The first note in a tree writes a slot at every level, at 97,920 state gas each. Twenty Poseidon hashes run at about 60,000
  // each on this fork. Unused gas is refunded.
  shield: (commitment: bigint, denomination: bigint): Call => ({ data: encode("shield", [commitment]), value: denomination, execution: SHIELD_EXECUTION_GAS, state: SHIELD_STATE_GAS }),
  // Paying a fresh address needs 183,600 spare execution gas: see `ops` in account.ts.
  unshield: (root: bigint, nullifierHash: bigint, recipient: Address): Call => ({ data: encode("unshield", [root, nullifierHash, recipient]), ...PROOF_FRAME_GAS.unshield }),
};

function proofTx(a: { account: Address; exit?: Address; verifyData: Hex; nonceKey: bigint; call: Call; verifyGas?: bigint; fees?: Fees }): FrameTx {
  const fees = a.fees ?? DEFAULT_FEES;
  return lib.newTx({
    chainId: DEVNET.chainId,
    sender: a.exit ?? a.account,
    nonceSeq: 0n,
    nonceKeys: [a.nonceKey],
    fees: { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? fees.maxFeePerGas },
    signatures: [],
    frames: [
      lib.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: a.verifyGas ?? PROOF_VERIFY_GAS, data: a.verifyData }),
      lib.frame(profile, "SENDER", { target: a.exit ? a.account : null, execution: a.call.execution, state: a.call.state, value: 0n, data: a.call.data }),
    ],
  });
}

/** `[VERIFY(proof), SENDER(queueRecovery)]`. Nothing here is secret, and nothing needs a key. */
/**
 * What the paper hands over for a recovery from the exit. Its keccak is `recoveryTicket`, so seeing that one does not give this one: a
 * stranger who copies a recovery sent from the account cannot resend it from the exit, on the reserve.
 */
export const exitTicket = (secret: bigint): Hex => keccak256(concat([toHex("vajra-recovery-ticket"), numberToHex(secret, { size: 32 })]));
/** What the paper hands over before a node will run the pairing. Its keccak is the gate `setRecovery` stores. */
export const recoveryTicket = (secret: bigint): Hex => keccak256(exitTicket(secret));
export const recoveryGate = (ticket: Hex): Hex => keccak256(ticket);

/** A number whose hash, with what comes before it, starts with `bits` zero bits. `encoded` ends with the 32-byte word it goes in. */
function solveWork(encoded: Hex, bits: number): bigint {
  const bytes = hexToBytes(encoded);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const last = bytes.length - 4;
  for (let work = 0; ; work++) {
    view.setUint32(last, work);
    if (bits === 0 || BigInt(keccak256(bytes)) >> BigInt(256 - bits) === 0n) return BigInt(work);
  }
}

/** The toll on an unshield. It covers everything the pairing is asked about, so a solved number buys one pairing. */
export function proofWork(a: { account: Address; proof: FlatProof; nonceKey: bigint; root: bigint; nullifierHash: bigint; recipient: Address }, bits = deployments().v2?.workBits ?? 0): bigint {
  const words = parseAbiParameters("address, uint256[8], uint256, uint256, uint256, address, uint256");
  return solveWork(encodeAbiParameters(words, [a.account, a.proof as never, a.nonceKey, a.root, a.nullifierHash, a.recipient, 0n]), bits);
}

/** The toll as it was on the bytes in `VajraAccountV2.pre-fix.json`, which `vajra proof-spam` still runs against. */
export const preFixProofWork = (account: Address, proof: FlatProof, nonceKey: bigint, bits = deployments().v2?.workBits ?? 0): bigint =>
  solveWork(encodeAbiParameters(parseAbiParameters("address, uint256[8], uint256, uint256"), [account, proof as never, nonceKey, 0n]), bits);

/** `ticket` is `recoveryTicket`, or `exitTicket` with `exit`. */
export function recoveryTx(a: { account: Address; exit?: Address; newRoot: Hex; nullifier: bigint; proof: FlatProof; ticket: Hex; verifyGas?: bigint; fees?: Fees }): FrameTx {
  return proofTx({
    account: a.account,
    exit: a.exit,
    verifyData: encode("validateRecovery", [a.proof, a.ticket]),
    nonceKey: recoveryNonceKey(a.nullifier, a.newRoot),
    call: opsV2.queueRecovery(a.newRoot, a.nullifier),
    verifyGas: a.verifyGas,
    fees: a.fees,
  });
}

/** `[VERIFY(proof), SENDER(unshield)]`. No key signs this, so nothing but the note ties it to anyone. */
export function unshieldTx(a: { account: Address; root: bigint; nullifierHash: bigint; recipient: Address; proof: FlatProof; work?: bigint; nonceKey?: bigint; verifyGas?: bigint; fees?: Fees }): FrameTx {
  const nonceKey = a.nonceKey ?? unshieldNonceKey(a.nullifierHash);
  return proofTx({
    account: a.account,
    verifyData: encode("validateUnshield", [a.proof, a.work ?? proofWork({ ...a, nonceKey })]),
    nonceKey,
    call: opsV2.unshield(a.root, a.nullifierHash, a.recipient),
    verifyGas: a.verifyGas,
    fees: a.fees,
  });
}

/** Pays a note its recipient refused. An ordinary call, so whoever sends it pays its gas: it has no frames and no nonce key of the account's. */
export const claimCall = (a: { proof: FlatProof; root: bigint; nullifierHash: bigint; recipient: Address }): Hex => encode("claim", [a.proof, a.root, a.nullifierHash, a.recipient]);

/** The account's own error name for a VERIFY revert, or the node's message when the refusal came from somewhere else. */
export function refusalNameV2(message: string): string {
  const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined;
  if (!data) return message;
  try {
    return decodeErrorResult({ abi: accountV2Abi, data }).errorName;
  } catch {
    return message;
  }
}
