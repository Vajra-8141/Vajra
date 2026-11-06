/**
 * Frame transactions for a VajraAccount.
 *
 * The codec comes from @forshtat/hegota-support, bound here to the devnet's profile. What this file adds is the shape
 * of the two paths, and the budget arithmetic that every frame limit has to respect.
 */
import { getProfile } from "@forshtat/hegota-support/profiles";
import { toWire } from "@forshtat/hegota-support/rpc";
import * as lib from "@forshtat/hegota-support/tx";
import {
  type Address,
  type Hex,
  concat,
  decodeErrorResult,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  numberToHex,
  parseSignature,
  toBytes,
  toRlp,
} from "viem";
import { DEVNET, RpcError, rpc, sleep } from "./devnet.ts";
import VajraAccount from "./artifacts/VajraAccount.json" with { type: "json" };
import VajraExit from "./artifacts/VajraExit.json" with { type: "json" };

export const accountAbi = VajraAccount.abi;
export const exitAbi = VajraExit.abi;
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
  /** Ties this frame to the next one: if either fails, both undo. EIP-8141's atomic batch. */
  atomic?: boolean;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
}

export const DEFAULT_FEES: Fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

/** A frame flag: this frame and the next stand or fall together. */
export const ATOMIC_BATCH_FLAG = 4;

const SPONSOR_SELECTOR = keccak256(toBytes("sponsor()")).slice(0, 10) as Hex;

const senderFrame = (call: Call) =>
  lib.frame(profile, "SENDER", {
    target: call.target ?? null,
    execution: call.execution,
    state: call.state,
    value: call.value ?? 0n,
    data: call.data,
    flags: call.atomic ? ATOMIC_BATCH_FLAG : 0,
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

const WALLET_TAG = keccak256(toBytes("vajra.daily.v1"));

/** `keccak256(be32(len) ‖ be32(k0) ‖ ...)`, TXPARAM's NONCE_KEYS_HASH. */
const nonceKeysHash = (keys: bigint[]): Hex =>
  keccak256(concat([numberToHex(keys.length, { size: 32 }), ...keys.map((k) => numberToHex(k, { size: 32 }))]));

/** The 32 bytes a stock wallet is asked to personal_sign, on a V1 account: what it rebuilds in `_walletDigest`. V2 takes `dailyTypedData`. */
export function walletMessage(tx: FrameTx): Hex {
  const body = tx.frames[1];
  if (tx.frames.length !== 2 || !body) throw new Error("a wallet-signed transaction is exactly [VERIFY, SENDER]");
  return keccak256(
    encodeAbiParameters(
      Array.from({ length: 10 }, (_, i) => ({ type: i === 0 || i === 4 || i === 9 ? "bytes32" : i === 2 ? "address" : "uint256" })),
      [
        WALLET_TAG,
        tx.chainId,
        tx.sender,
        tx.nonceSeq,
        nonceKeysHash(tx.nonceKeys),
        tx.fees.maxFeePerGas,
        tx.fees.maxPriorityFeePerGas,
        body.limits.execution,
        body.limits.state,
        keccak256(body.data),
      ],
    ),
  );
}

/** Attaches a wallet's 65-byte `r ‖ s ‖ v` signature, repacked as the protocol wants it: `v (0 or 1) ‖ r ‖ s`. */
export function withWalletSignature(tx: FrameTx, signature: Hex): FrameTx {
  const { r, s, yParity } = parseSignature(signature);
  const packed = concat([numberToHex(yParity ?? 0, { size: 1 }), r, s]);
  const msg = hashMessage({ raw: walletMessage(tx) });
  return { ...tx, signatures: tx.signatures.map((e, i) => (i === 0 ? { ...e, msg, signature: packed } : e)) };
}

const DAILY_FEE_FIELDS = [
  { name: "nonce", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "maxPriorityFeePerGas", type: "uint256" },
  { name: "executionGas", type: "uint256" },
  { name: "stateGas", type: "uint256" },
  { name: "verifyGas", type: "uint256" },
  { name: "maxCost", type: "uint256" },
] as const;

const DAILY_TYPES = {
  DailySpend: [{ name: "asset", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, ...DAILY_FEE_FIELDS],
  DailyExecute: [{ name: "id", type: "uint256" }, ...DAILY_FEE_FIELDS],
} as const;

const SIGNATURE_COST: Record<number, bigint> = { [profile.sigSchemes.ARBITRARY!]: 100n, [profile.sigSchemes.SECP256K1!]: 2_800n, [profile.sigSchemes.P256!]: 6_700n };

/**
 * ethrex's `total_gas_limit`, in crates/common/types/transaction.rs. TXPARAM's MAX_COST is this times `maxFeePerGas`, when there are no
 * blobs. Data costs 4 gas a zero byte and 16 any other, and the floor is 64 a byte whatever it holds.
 */
export function maxGas(tx: FrameTx): bigint {
  if (tx.blobVersionedHashes.length > 0 || tx.recentRootReferences.length > 0) throw new Error("this arithmetic has no blobs or recent roots in it");
  const nonces = concat([toRlp(tx.nonceKeys.map((k) => (k === 0n ? "0x" : numberToHex(k)))), toRlp(tx.nonceSeq === 0n ? "0x" : numberToHex(tx.nonceSeq))]);
  const fields = [...tx.frames.map((f) => f.data), ...tx.signatures.flatMap((s) => [s.signer, s.msg, s.signature]), nonces].map((field) => hexToBytes(field));
  const data = fields.flatMap((field) => [...field]).reduce((sum, byte) => sum + (byte === 0 ? 4n : 16n), 0n);
  const size = fields.reduce((sum, field) => sum + BigInt(field.length), 0n);
  const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
  const mandatory =
    12_000n + 475n * BigInt(tx.frames.length) + sum(tx.signatures.map((s) => SIGNATURE_COST[s.scheme] ?? 0n)) + 6_000n * BigInt(tx.frames.filter((f) => f.value !== 0n).length);
  const execution = sum(tx.frames.map((f) => f.limits.execution));
  const state = sum(tx.frames.map((f) => f.limits.state));
  return (mandatory + data + execution > mandatory + size * 64n ? mandatory + data + execution : mandatory + size * 64n) + state;
}

/** `validateDaily(scope)`, with nothing after it. */
const VERIFY_DATA_HEX_LENGTH = 2 + (4 + 32) * 2;
const withVerifyData = (tx: FrameTx, data: Hex): FrameTx => ({ ...tx, frames: tx.frames.map((f, i) => (i === 0 ? { ...f, data } : f)) });
const bareVerifyData = (tx: FrameTx) => tx.frames[0]!.data.slice(0, VERIFY_DATA_HEX_LENGTH) as Hex;
const NO_ZERO_MSG = `0x${"ff".repeat(32)}` as Hex;
const NO_ZERO_SIGNATURE = `0x${"ff".repeat(65)}` as Hex;

/**
 * The gas a wallet signs for. `msg` and the signature are part of what a transaction costs, and they cost less for each zero byte they
 * hold, which nobody can know before signing. So this assumes none, and `withTypedSignature` makes up what they saved.
 */
const signedGas = (tx: FrameTx) =>
  maxGas({ ...withVerifyData(tx, bareVerifyData(tx)), signatures: tx.signatures.map((e, i) => (i === 0 ? { ...e, msg: NO_ZERO_MSG, signature: NO_ZERO_SIGNATURE } : e)) });

/**
 * What a wallet is asked to sign on a V2 account, as EIP-712 typed data, so that it can show the asset, the recipient and the
 * amount instead of 32 blind bytes. The account rebuilds this from the frames in `_typedDigest`, so it has to match field for field.
 */
export function dailyTypedData(tx: FrameTx) {
  const body = tx.frames[1];
  if (tx.frames.length !== 2 || !body) throw new Error("a wallet-signed transaction is exactly [VERIFY, SENDER]");
  const { functionName, args } = decodeFunctionData({ abi: accountAbi, data: body.data }) as { functionName: string; args: readonly unknown[] };
  const common = {
    nonce: tx.nonceSeq,
    maxFeePerGas: tx.fees.maxFeePerGas,
    maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
    executionGas: body.limits.execution,
    stateGas: body.limits.state,
    verifyGas: tx.frames[0]!.limits.execution,
    maxCost: tx.fees.maxFeePerGas * signedGas(tx),
  };
  const domain = { name: "VAJRA", version: "2", chainId: Number(tx.chainId), verifyingContract: tx.sender };
  if (functionName === "spend") {
    const [asset, recipient, amount] = args as [Address, Address, bigint];
    return { domain, types: DAILY_TYPES, primaryType: "DailySpend" as const, message: { asset, recipient, amount, ...common } };
  }
  if (functionName === "executeQueued") {
    const [id] = args as [bigint];
    return { domain, types: DAILY_TYPES, primaryType: "DailyExecute" as const, message: { id, ...common } };
  }
  throw new Error(`a wallet can only sign spend and executeQueued, not ${functionName}`);
}

/**
 * Attaches a wallet's 65-byte signature over `dailyTypedData`, repacked as in `withWalletSignature`.
 *
 * The account holds the cost to exactly what was signed. Each zero byte in `msg` or the signature saved 12 gas of what `signedGas` counted,
 * and 3 zero bytes after frame 0's argument put that back. `validateDaily` does not read them, and frame 0's data is not signed.
 */
export function withTypedSignature(tx: FrameTx, signature: Hex): FrameTx {
  const { r, s, yParity } = parseSignature(signature);
  const packed = concat([numberToHex(yParity ?? 0, { size: 1 }), r, s]);
  const msg = hashTypedData(dailyTypedData(tx) as never);
  const signed = { ...withVerifyData(tx, bareVerifyData(tx)), signatures: tx.signatures.map((e, i) => (i === 0 ? { ...e, msg, signature: packed } : e)) };
  const padded = withVerifyData(signed, `${bareVerifyData(tx)}${"00".repeat(Number((signedGas(tx) - maxGas(signed)) / 4n))}`);
  if (maxGas(padded) !== signedGas(tx)) throw new Error("this transaction's cost cannot be made to match what was signed");
  return padded;
}

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

/**
 * `[VERIFY(exit), SENDER...]` from the account's second sender, on a leaf of the exit tree. The frames target the account. Its
 * digest is `masterDigest` with the exit's address in the account's place.
 */
export function exitTx(a: { exit: Address; account: Address; root: Hex; leaf: number; calls: Call[]; verifyGas?: bigint; fees?: Fees }): FrameTx {
  return lib.newTx({
    chainId: DEVNET.chainId,
    sender: a.exit,
    nonceSeq: 0n,
    nonceKeys: [leafNonceKey(a.root, a.leaf)],
    fees: fees(a.fees ?? DEFAULT_FEES),
    signatures: [{ scheme: profile.sigSchemes.ARBITRARY!, signer: "0x", msg: "0x", signature: "0x" }],
    frames: [
      lib.frame(profile, "VERIFY", {
        scope: "EXECUTION_AND_PAYMENT",
        execution: a.verifyGas ?? MAX_VERIFY_GAS - ARBITRARY_SIGNATURE_COST,
        data: encodeFunctionData({ abi: exitAbi, functionName: "validateExit" }),
      }),
      ...a.calls.map((call) => senderFrame({ ...call, target: call.target ?? a.account })),
    ],
  });
}

/**
 * `limits.execution` budget for a stealth spend. The live cap counts the whole prefix, so `validateMaster` and the
 * paymaster share it, along with the 2,900 gas of intrinsic cost for the two signature entries.
 */
export const STEALTH_LIMITS = { verify: 82_000n, pay: 15_000n } as const;

/**
 * `[VERIFY(master), VERIFY(pay), SENDER...]` on the account's linear nonce. Two signature entries: entry 0 is the WOTS
 * blob, entry 1 the ERC-8441 stealth key co-signing. Both are elided from the signature hash, so both sign the same
 * thing, and neither has to know about the other.
 */
export function stealthTx(a: { account: Address; leaf: number; paymaster: Address; coSigner: Address; calls: Call[]; fees?: Fees }): FrameTx {
  return lib.newTx({
    chainId: DEVNET.chainId,
    sender: a.account,
    nonceSeq: BigInt(a.leaf + 1),
    fees: fees(a.fees ?? DEFAULT_FEES),
    signatures: [{ scheme: profile.sigSchemes.ARBITRARY!, signer: "0x", msg: "0x", signature: "0x" }, lib.secp256k1Placeholder(profile, a.coSigner)],
    frames: [
      verifyFrame("validateMaster", Scope.Execution, STEALTH_LIMITS.verify),
      lib.frame(profile, "VERIFY", { scope: "PAYMENT", target: a.paymaster, execution: STEALTH_LIMITS.pay, data: SPONSOR_SELECTOR }),
      ...a.calls.map(senderFrame),
    ],
  });
}

export const coSignTx = (tx: FrameTx, privateKey: Hex) => lib.signTx(profile, tx, privateKey, 1);

export function withMasterSignature(tx: FrameTx, blob: Hex): FrameTx {
  return { ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature: blob } : s)) };
}

/**
 * A node reports a VERIFY revert as hex. This gives back the account's own error name, or the node's message when the
 * refusal came from somewhere else.
 */
export function refusalName(message: string): string {
  const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined;
  if (!data) return message;
  try {
    return decodeErrorResult({ abi: accountAbi, data }).errorName;
  } catch {
    return message;
  }
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

/** What ethrex would do with this transaction: its canonical verdict, and full execution regardless of that verdict. `simulate` adds the alt mempool. */
export const simulateFrames = (tx: FrameTx, block: string = "latest", trace = false) =>
  rpc<SimulationResult>(DEVNET.execution, "ethrex_simulateFrameTransaction", [encodeTx(tx), block, { trace }]);

/**
 * Into the alt mempool. The miner's sidecar comes first, because the gateway has been seen to hold transactions it never
 * forwarded, but an escape should not depend on one host. The gateway is tried only when the miner cannot be reached: a
 * node's refusal is an answer, and it is not retried elsewhere.
 */
export async function sendAlt(tx: FrameTx): Promise<Hex> {
  const wire = toWire(tx);
  try {
    return await rpc<Hex>(DEVNET.mempool, "eth_sendFrameTransaction", [wire]);
  } catch (error) {
    if (error instanceof RpcError && error.code !== 502 && error.code !== 503 && error.code !== 504) throw error;
    return rpc<Hex>(DEVNET.gateway, "eth_sendFrameTransaction", [wire]);
  }
}

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

