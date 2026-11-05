/**
 * Frame transactions for a VajraAccount.
 *
 * The codec comes from @forshtat/hegota-support, bound here to the devnet's profile. What this file adds is the shape
 * of the two paths, and the budget arithmetic that every frame limit has to respect.
 */
import { getProfile } from "@forshtat/hegota-support/profiles";
import { toWire } from "@forshtat/hegota-support/rpc";
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, concat, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex } from "viem";
import { DEVNET, RpcError, rpc, sleep } from "./devnet.ts";
import VajraAccount from "./artifacts/VajraAccount.json" with { type: "json" };

export const accountAbi = VajraAccount.abi;
export const profile = getProfile("ethrex-eip8141-tracer");
export type FrameTx = lib.FrameTx;

/**
 * The cap the live sidecar and ethrex both enforce: the prefix's declared `limits.execution` plus the intrinsic
 * signature cost. Staking does not raise it on the deployed sidecar, measured on 2026-11-05 (see docs/FINDINGS.md).
 */
export const MAX_VERIFY_GAS = 100_000n;
const ARBITRARY_SIGNATURE_COST = 100n;

/** Approve scopes, as `validateDaily` and `validateMaster` take them. */
export const Scope = { Execution: 2, ExecutionAndPayment: 3 } as const;

/** A call the account makes to itself, or with the master key to anywhere. */
export interface Call {
  data: Hex;
  /** Omitted: the account itself. */
  target?: Address;
  value?: bigint;
  execution: bigint;
  state: bigint;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
}

export const DEFAULT_FEES: Fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

const senderFrame = (call: Call) =>
  lib.frame(profile, "SENDER", {
    target: call.target ?? null,
    execution: call.execution,
    state: call.state,
    value: call.value ?? 0n,
    data: call.data,
  });

const verifyFrame = (fn: "validateDaily" | "validateMaster", scope: number, execution: bigint) =>
  lib.frame(profile, "VERIFY", {
    scope: scope === Scope.ExecutionAndPayment ? "EXECUTION_AND_PAYMENT" : "EXECUTION",
    execution,
    data: encodeFunctionData({ abi: accountAbi, functionName: fn, args: [scope] }),
  });

export const sigHash = (tx: FrameTx): Hex => lib.sigHash(profile, tx);
export const txHash = (tx: FrameTx): Hex => lib.txHash(profile, tx);
export const encodeTx = (tx: FrameTx): Hex => lib.encodeTx(profile, tx);

function fees(f: Fees) {
  return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? f.maxFeePerGas };
}

/** `[VERIFY(daily), SENDER...]` on the account's linear nonce. The daily key pays nothing: the account does. */
export function dailyTx(a: { account: Address; dailyKey: Address; nonce: bigint; calls: Call[]; verifyGas?: bigint; fees?: Fees }): FrameTx {
  return lib.newTx({
    chainId: DEVNET.chainId,
    sender: a.account,
    nonceSeq: a.nonce,
    fees: fees(a.fees ?? DEFAULT_FEES),
    signatures: [lib.secp256k1Placeholder(profile, a.dailyKey)],
    frames: [verifyFrame("validateDaily", Scope.ExecutionAndPayment, a.verifyGas ?? 60_000n), ...a.calls.map(senderFrame)],
  });
}

export const signDailyTx = (tx: FrameTx, privateKey: Hex) => lib.signTx(profile, tx, privateKey);

/** Spec §5, and `masterDigest` on the account. */
export function masterDigest(a: { chainId: number; epochSalt: Hex; account: Address; nonceKey: bigint; sigHash: Hex }): Hex {
  return keccak256(concat([numberToHex(a.chainId, { size: 32 }), a.epochSalt, a.account, numberToHex(a.nonceKey, { size: 32 }), a.sigHash]));
}

/** One leaf, one nonce key, derived from the root so that no two trees share a key. */
export function leafNonceKey(root: Hex, leaf: number): bigint {
  return BigInt(keccak256(concat([root, numberToHex(leaf, { size: 1 })])));
}

/**
 * `[VERIFY(master), SENDER...]` on the leaf's own nonce key, with an ARBITRARY signature entry. The entry is empty
 * here: its bytes are elided from the signature hash, which is what the master key signs.
 */
export function masterTx(a: { account: Address; root: Hex; leaf: number; calls: Call[]; verifyGas?: bigint; fees?: Fees }): FrameTx {
  const limit = a.verifyGas ?? MAX_VERIFY_GAS - ARBITRARY_SIGNATURE_COST;
  return lib.newTx({
    chainId: DEVNET.chainId,
    sender: a.account,
    nonceSeq: 0n,
    nonceKeys: [leafNonceKey(a.root, a.leaf)],
    fees: fees(a.fees ?? DEFAULT_FEES),
    signatures: [{ scheme: profile.sigSchemes.ARBITRARY!, signer: "0x", msg: "0x", signature: "0x" }],
    frames: [verifyFrame("validateMaster", Scope.ExecutionAndPayment, limit), ...a.calls.map(senderFrame)],
  });
}

export function withMasterSignature(tx: FrameTx, blob: Hex): FrameTx {
  return { ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature: blob } : s)) };
}

export interface SimulationResult {
  canonicalMempoolValid: boolean;
  canonicalMempoolViolation: string | null;
  prefixShape: string | null;
  payer: Address | null;
  maxCost: Hex;
  gasUsed: Hex | null;
  frames: { gasUsed: Hex; succeeded: boolean }[] | null;
  executionStatus: string | null;
  executionError: string | null;
  failure?: unknown;
}

/** What ethrex would do with this transaction: its canonical verdict, and full execution regardless of that verdict. */
export const simulate = (tx: FrameTx, block: string = "latest") =>
  rpc<SimulationResult>(DEVNET.execution, "ethrex_simulateFrameTransaction", [encodeTx(tx), block, { trace: false }]);

/** Into the alt mempool. */
export const sendAlt = (tx: FrameTx, url: string = DEVNET.mempool) => rpc<Hex>(url, "eth_sendFrameTransaction", [toWire(tx)]);

/** Into ethrex's own mempool, the canonical one. */
export const sendCanonical = (tx: FrameTx) => rpc<Hex>(DEVNET.execution, "eth_sendRawTransaction", [encodeTx(tx)]);

export interface FrameReceipt {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  frameReceipts: { status: Hex; gasUsed: Hex; stateGasUsed: Hex; logs: unknown[] }[];
}

export const receiptOf = (hash: Hex) => rpc<FrameReceipt | null>(DEVNET.execution, "eth_getTransactionReceipt", [hash]);

type Status = { status: string; reason?: string };

/**
 * Sends and waits, rebroadcasting if the node gives up on the transaction.
 *
 * Roughly one transaction in twenty is admitted and then cancelled after four relays without being included. Sending
 * the identical bytes again is always safe, and for a one-time key it is the only safe retry: `tx` is already signed,
 * so a rebroadcast reveals nothing new, whereas signing anything else with this leaf would.
 */
export async function submit(tx: FrameTx, opts: { timeoutMs?: number; log?: (line: string) => void } = {}): Promise<{ hash: Hex; receipt: FrameReceipt; attempts: number }> {
  const log = opts.log ?? (() => {});
  const hash = txHash(tx);
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  let attempts = 0;
  let live = false;
  while (Date.now() < deadline) {
    const receipt = await receiptOf(hash);
    if (receipt) return { hash, receipt, attempts };
    if (!live) {
      attempts++;
      try {
        await sendAlt(tx);
        log(`admitted by the alt mempool (attempt ${attempts}): ${hash}`);
      } catch (error) {
        if (!(error instanceof RpcError) || !/already known/i.test(error.message)) throw error;
      }
      live = true;
    } else {
      const status = await rpc<Status>(DEVNET.mempool, "skandha_frameTransactionStatus", [hash]).catch(() => null);
      if (status && (status.status === "Cancelled" || status.status === "Reverted")) {
        log(`node reports ${status.status}: ${status.reason ?? "no reason given"}; rebroadcasting the same bytes`);
        live = false;
      }
    }
    await sleep(3000);
  }
  throw new Error(`${hash} not mined in time`);
}

export const framesSucceeded = (r: FrameReceipt) => r.status === "0x1" && r.frameReceipts.every((f) => f.status === "0x1");

export { encodeAbiParameters };
