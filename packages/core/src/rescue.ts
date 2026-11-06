/**
 * A rescue: one transaction the hash key signed in advance, which moves everything to the sealed harbor and can do nothing else.
 *
 * It runs from the exit, on a nonce key of its own, and pays from the exit's reserve, so nothing the account does later and nothing a
 * thief with the daily key does can invalidate it. On a plain account this cannot work: its next transaction would spend the nonce a
 * pre-signed one is waiting on. See docs/FINDINGS.md section 23.
 *
 * Whoever holds it can send it, and holds no key. All they can do is send the owner's money to the owner's harbor, and they learn where
 * that is. So a nominee needs no trust with the money, and every field here is read from the signed bytes, because a file can lie.
 *
 * Runs in a browser and in Node.
 */
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, decodeErrorResult, decodeFunctionData, encodeFunctionData, getAddress, hexToBytes } from "viem";
import { type QueuedView, harborCommitment, ops, readAccount, signExitTx } from "./account.ts";
import { publicClient } from "./chain.ts";
import { DEVNET, RpcError, genesisHash, sleep } from "./devnet.ts";
import { type Call, type Fees, type FrameTx, accountAbi, encodeTx, exitAbi, framesSucceeded, leafNonceKey, maxGas, profile, receiptOf, sendCanonical, simulateFrames, submit, txHash } from "./frame.ts";
import type { MasterSigner } from "./signer.ts";
import { accountV2Abi } from "./zk.ts";

export const RESCUE_KIND = "vajra-rescue-v1";

/** What goes in the file. Only `tx` is signed, so nothing else here may be trusted for more than a label. */
export interface RescueFile {
  kind: typeof RESCUE_KIND;
  chainId: number;
  genesis: Hex;
  /** How long before a waiting payment would leave that the rescue goes out. */
  marginSeconds: number;
  tx: Hex;
}

export interface Rescue {
  tx: FrameTx;
  hash: Hex;
  genesis: Hex;
  marginSeconds: number;
  account: Address;
  exit: Address;
  harbor: Address;
  harborSalt: Hex;
  extraTokens: readonly Address[];
  /** What the mempool holds against the exit's balance before it will carry this. Unused gas comes back. */
  maxCost: bigint;
}

/** A file that is not a rescue. The watcher and the page refuse it, because a holder must never be tricked into sending something else. */
export class RescueInvalid extends Error {
  constructor(reason: string) {
    super(`not a rescue: ${reason}`);
    this.name = "RescueInvalid";
  }
}

/** A quarter of the queue's delay, and at most an hour. Long enough to land, and late enough that the owner has had most of the delay to answer. */
export const defaultMargin = (queueDelay: number) => Math.min(Math.floor(queueDelay / 4), 3600);

/**
 * `escape`, with gas for a token that fights: a sweep gives one up to `SWEEP_GAS` for its balance and again for its transfer. Gas is signed
 * here and cannot be raised later, and a frame that runs out still spends the nonce key, so this errs high. Unused gas comes back.
 */
export function rescueCall(harbor: Address, harborSalt: Hex, tokens: number, extra: Address[] = []): Call {
  const call = ops.escape(harbor, harborSalt, extra);
  return { ...call, execution: call.execution + 600_000n * BigInt(tokens), state: call.state + 100_000n * BigInt(tokens) };
}

/** Signs it, which reveals a leaf of the exit tree to whoever gets the bytes. `tokens` counts every token the sweep will touch, configured or extra. */
export function signRescue(a: { signer: MasterSigner; exit: Address; account: Address; epochSalt: Hex; harbor: Address; harborSalt: Hex; tokens: number; extra?: Address[]; fees?: Fees }): { tx: FrameTx; leaf: number } {
  const { tx, leaf } = signExitTx({ signer: a.signer, exit: a.exit, account: a.account, epochSalt: a.epochSalt, calls: [rescueCall(a.harbor, a.harborSalt, a.tokens, a.extra)], fees: a.fees });
  return { tx, leaf };
}

export const rescueFile = (a: { tx: FrameTx; genesis: Hex; marginSeconds: number }): string =>
  JSON.stringify({ kind: RESCUE_KIND, chainId: Number(a.tx.chainId), genesis: a.genesis, marginSeconds: a.marginSeconds, tx: encodeTx(a.tx) } satisfies RescueFile, null, 1) + "\n";

const VALIDATE_EXIT = encodeFunctionData({ abi: exitAbi, functionName: "validateExit" });
const ARBITRARY = profile.sigSchemes.ARBITRARY!;

/** Reads a rescue out of a file, and refuses anything else. A real signature on anything but `escape` is refused too: it could be a veto, or something from another account's exit. */
export function parseRescue(text: string): Rescue {
  let file: RescueFile;
  try {
    file = JSON.parse(text) as RescueFile;
  } catch {
    throw new RescueInvalid("this is not JSON");
  }
  if (file?.kind !== RESCUE_KIND) throw new RescueInvalid(`this file says it is ${String(file?.kind)}`);
  if (!Number.isSafeInteger(file.marginSeconds) || file.marginSeconds < 0) throw new RescueInvalid("its margin is not a number of seconds");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(file.genesis))) throw new RescueInvalid("it names no chain");
  let tx: FrameTx;
  try {
    tx = lib.decodeTx(profile, file.tx);
  } catch (error) {
    throw new RescueInvalid(`its transaction does not decode: ${(error as Error).message}`);
  }
  if (Number(tx.chainId) !== DEVNET.chainId) throw new RescueInvalid(`it is for chain ${tx.chainId}, and this is chain ${DEVNET.chainId}`);
  if (tx.blobVersionedHashes.length || tx.recentRootReferences.length) throw new RescueInvalid("it carries blobs or roots");
  if (tx.frames.length !== 2) throw new RescueInvalid("it has to be exactly one VERIFY frame and one SENDER frame");
  const [verify, body] = tx.frames as [FrameTx["frames"][0], FrameTx["frames"][0]];
  if (verify.mode !== profile.frameModes.VERIFY || verify.target !== null || verify.data !== VALIDATE_EXIT) throw new RescueInvalid("its first frame is not an exit's own check");
  if (body.mode !== profile.frameModes.SENDER || !body.target || body.value !== 0n) throw new RescueInvalid("its second frame is not a plain call to an account");
  if (tx.signatures.length !== 1 || tx.signatures[0]!.scheme !== ARBITRARY || hexToBytes(tx.signatures[0]!.signature).length === 0) throw new RescueInvalid("it is not signed by a hash key");
  let args: readonly [Address, Hex, readonly Address[]];
  try {
    const decoded = decodeFunctionData({ abi: accountAbi, data: body.data }) as { functionName: string; args: readonly [Address, Hex, readonly Address[]] };
    if (decoded.functionName !== "escape") throw new RescueInvalid(`it calls ${decoded.functionName}, and a rescue only escapes`);
    args = decoded.args;
  } catch (error) {
    if (error instanceof RescueInvalid) throw error;
    throw new RescueInvalid("its second frame is not an escape");
  }
  return {
    tx,
    hash: txHash(tx),
    genesis: file.genesis,
    marginSeconds: file.marginSeconds,
    account: getAddress(body.target),
    exit: getAddress(tx.sender),
    harbor: getAddress(args[0]),
    harborSalt: args[1],
    extraTokens: args[2],
    maxCost: maxGas(tx) * tx.fees.maxFeePerGas,
  };
}

export type RescueCheck =
  | { state: "ready"; reserve: bigint; maxCost: bigint; verifyGas: number; totalGas: number }
  | { state: "sent"; hash: Hex | null; block: number | null; succeeded: boolean | null }
  | { state: "broken"; reason: string }
  | { state: "unknown"; reason: string };

/** The node's refusal, in the exit's own words when it has them. */
function refusal(message: string): string {
  const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined;
  if (!data) return message;
  try {
    return decodeErrorResult({ abi: exitAbi, data }).errorName;
  } catch {
    return message;
  }
}

/** Would this work if sent now? It asks the node and sends nothing. A node that cannot be reached is unknown, and never ready. */
export async function checkRescue(r: Rescue): Promise<RescueCheck> {
  try {
    if ((await genesisHash()) !== r.genesis) return { state: "broken", reason: "This was signed on a chain that has since been reset." };
    const receipt = await receiptOf(r.hash);
    if (receipt) return { state: "sent", hash: r.hash, block: Number(BigInt(receipt.blockNumber)), succeeded: framesSucceeded(receipt) };

    const read = <T>(functionName: string) => publicClient.readContract({ address: r.account, abi: accountV2Abi as never, functionName } as never) as Promise<T>;
    const [named, commitment, reserve, root] = await Promise.all([
      read<Address>("exit"),
      read<Hex>("harborCommitment"),
      publicClient.getBalance({ address: r.exit }),
      publicClient.readContract({ address: r.exit, abi: exitAbi, functionName: "root" }) as Promise<Hex>,
    ]);
    if (getAddress(named) !== r.exit) return { state: "broken", reason: "The account no longer names this exit." };
    if (harborCommitment(r.harbor, r.harborSalt) !== commitment) return { state: "broken", reason: "The owner changed the harbor after this was signed, so it would fail and move nothing." };
    const leaf = hexToBytes(r.tx.signatures[0]!.signature)[0]!;
    if (leafNonceKey(root, leaf) !== r.tx.nonceKeys[0]) return { state: "broken", reason: "The exit's key tree was replaced after this was signed, so this rescue no longer works. Ask the owner for a new one." };

    let sim: Awaited<ReturnType<typeof simulateFrames>> | null = null;
    let failure: string | null = null;
    try {
      sim = await simulateFrames(r.tx);
      if (!sim.frames?.[0]?.succeeded) failure = String(sim.executionError ?? "its VERIFY frame fails");
    } catch (error) {
      if (!(error instanceof RpcError) || error.code >= 0) throw error;
      failure = error.message;
    }
    // Someone sent a copy with the same signature and different padding: its hash is not ours, but the nonce key is spent.
    if (failure && /nonce mismatch/i.test(failure)) return { state: "sent", hash: null, block: null, succeeded: null };
    if (failure || !sim?.frames) return { state: "broken", reason: `It would be refused: ${failure}` };
    if (!sim.frames.every((frame) => frame.succeeded)) return { state: "broken", reason: `Its SENDER frame would fail, and spend the nonce key: ${sim.executionError ?? "no reason given"}. Ask the owner for a new one.` };
    if (reserve < r.maxCost) return { state: "broken", reason: `The exit holds ${reserve} wei, and this can cost up to ${r.maxCost}. Anyone can top up ${r.exit}.` };
    return { state: "ready", reserve, maxCost: r.maxCost, verifyGas: Number(BigInt(sim.frames[0]!.gasUsed)), totalGas: Number(BigInt(sim.gasUsed ?? "0x0")) };
  } catch (error) {
    return { state: "unknown", reason: (error as Error).message };
  }
}

export interface RescueDue {
  now: number;
  frozen: boolean;
  /** What will really leave if nobody answers. */
  waiting: QueuedView[];
  soonest: number | null;
  /** Seconds until the rescue should go, or null if nothing is waiting. */
  sendIn: number | null;
  due: boolean;
}

/**
 * The switch: is something about to leave that nobody has answered? An answer ends an item: **Not me** cancels it, and **Pay, it's me**
 * cancels it and pays it. So an item still waiting at the margin means the owner is not there.
 *
 * A freeze stops a spend from maturing and does not stop a recovery, so on a frozen account only a recovery counts. Throws if the chain
 * cannot be read: an unknown queue must never look like an empty one.
 */
export async function rescueDue(r: Rescue, margin: number = r.marginSeconds): Promise<RescueDue> {
  const [view, block] = await Promise.all([readAccount(r.account), publicClient.getBlock()]);
  const now = Number(block.timestamp);
  let waiting = view.items.filter((item) => item.state === 1);
  if (view.frozen) {
    const recovery = await Promise.all(waiting.map((item) => publicClient.readContract({ address: r.account, abi: accountV2Abi as never, functionName: "isRecovery", args: [item.id] } as never) as Promise<boolean>));
    waiting = waiting.filter((_, i) => recovery[i]);
  }
  const soonest = waiting.length ? Math.min(...waiting.map((item) => Number(item.executeAfter))) : null;
  const sendIn = soonest === null ? null : soonest - margin - now;
  return { now, frozen: view.frozen, waiting, soonest, sendIn, due: sendIn !== null && sendIn <= 0 };
}

/**
 * Sends the same bytes through whichever mempool takes them. The alt mempool first, then the canonical one, which also takes an exit's
 * transaction with a thief's pending: the sender is not the account. There is nothing to re-sign, and nothing else to try.
 */
export async function sendRescue(r: Rescue, o: { log?: (line: string) => void; timeoutMs?: number } = {}) {
  const log = o.log ?? (() => {});
  try {
    const { hash, receipt } = await submit(r.tx, { log, timeoutMs: o.timeoutMs ?? 120_000 });
    return { hash, receipt, route: "alt" as const };
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    log(`the alt mempool refused it: ${refusal(error.message)}. Trying the canonical mempool`);
  }
  await sendCanonical(r.tx);
  const deadline = Date.now() + (o.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const receipt = await receiptOf(r.hash);
    if (receipt) return { hash: r.hash, receipt, route: "canonical" as const };
    await sleep(1000);
  }
  throw new Error(`${r.hash} was admitted and not mined in time`);
}
