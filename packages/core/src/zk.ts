/**
 * Transactions authorized by a proof instead of a signature. These run on the local mirror only: the pairing check costs more
 * than the deployed sidecar's flat cap, and uses precompiles it refuses.
 *
 * The contract pins everything a signature would have committed to, so these builders have to produce exactly that shape:
 * see `_requireProofShape` in VajraAccountV2.
 */
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, concat, decodeErrorResult, encodeFunctionData, keccak256, numberToHex, toBytes } from "viem";
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

export const recoveryNonceKey = (nullifier: bigint): bigint => BigInt(keccak256(concat([RECOVERY_TAG, word(nullifier)])));

export const unshieldNonceKey = (nullifierHash: bigint): bigint => BigInt(keccak256(concat([UNSHIELD_TAG, word(nullifierHash)])));

const encode = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: accountV2Abi, functionName, args });

export const SHIELD_EXECUTION_GAS = 2_500_000n;
export const SHIELD_STATE_GAS = 3_000_000n;

export const opsV2 = {
  setRecovery: (commitment: bigint, delay: bigint): Call => ({ data: encode("setRecovery", [commitment, delay]), execution: 80_000n, state: 300_000n }),
  queueRecovery: (root: Hex, nullifier: bigint): Call => ({ data: encode("queueRecovery", [root, nullifier]), execution: 200_000n, state: 600_000n }),
  // The first note in a tree writes a slot at every level, at 97,920 state gas each. Twenty Poseidon hashes run at about 60,000
  // each on this fork. Unused gas is refunded.
  shield: (commitment: bigint, denomination: bigint): Call => ({ data: encode("shield", [commitment]), value: denomination, execution: SHIELD_EXECUTION_GAS, state: SHIELD_STATE_GAS }),
  // Paying a fresh address needs 183,600 spare execution gas: see `ops` in account.ts.
  unshield: (root: bigint, nullifierHash: bigint, recipient: Address): Call => ({ data: encode("unshield", [root, nullifierHash, recipient]), execution: 400_000n, state: 400_000n }),
};

function proofTx(a: { account: Address; verifyData: Hex; nonceKey: bigint; call: Call; verifyGas?: bigint; fees?: Fees }): FrameTx {
  const fees = a.fees ?? DEFAULT_FEES;
  return lib.newTx({
    chainId: DEVNET.chainId,
    sender: a.account,
    nonceSeq: 0n,
    nonceKeys: [a.nonceKey],
    fees: { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? fees.maxFeePerGas },
    signatures: [],
    frames: [
      lib.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: a.verifyGas ?? PROOF_VERIFY_GAS, data: a.verifyData }),
      lib.frame(profile, "SENDER", { target: null, execution: a.call.execution, state: a.call.state, value: 0n, data: a.call.data }),
    ],
  });
}

/** `[VERIFY(proof), SENDER(queueRecovery)]`. Nothing here is secret, and nothing needs a key. */
export function recoveryTx(a: { account: Address; newRoot: Hex; nullifier: bigint; proof: FlatProof; verifyGas?: bigint; fees?: Fees }): FrameTx {
  return proofTx({
    account: a.account,
    verifyData: encode("validateRecovery", [a.proof]),
    nonceKey: recoveryNonceKey(a.nullifier),
    call: opsV2.queueRecovery(a.newRoot, a.nullifier),
    verifyGas: a.verifyGas,
    fees: a.fees,
  });
}

/** `[VERIFY(proof), SENDER(unshield)]`. No key signs this, so nothing but the note ties it to anyone. */
export function unshieldTx(a: { account: Address; root: bigint; nullifierHash: bigint; recipient: Address; proof: FlatProof; verifyGas?: bigint; fees?: Fees }): FrameTx {
  return proofTx({
    account: a.account,
    verifyData: encode("validateUnshield", [a.proof]),
    nonceKey: unshieldNonceKey(a.nullifierHash),
    call: opsV2.unshield(a.root, a.nullifierHash, a.recipient),
    verifyGas: a.verifyGas,
    fees: a.fees,
  });
}

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
