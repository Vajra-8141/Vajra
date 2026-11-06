/**
 * A rescue: one transaction the hash key signed in advance, which moves everything to the sealed harbor and can do nothing else.
 *
 * It runs from the exit, on a nonce key of its own, and pays from the exit's reserve, so nothing the account does later and nothing a
 * thief with the daily key does can invalidate it. On a plain account this cannot work: its next transaction would spend the nonce a
 * pre-signed one is waiting on. See docs/FINDINGS.md section 23.
 *
 * Whoever holds it can send it, and holds no key. All they can do is send the owner's money to the owner's harbor, and they learn where
 * that is. So a nominee needs no trust with the money. Every field here is read from the transaction's own bytes, because a file can lie,
 * and only the node can say those bytes are really signed: `checkRescue` asks it, and until then a loaded file proves nothing.
 *
 * Runs in a browser and in Node.
 */
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, decodeErrorResult, decodeFunctionData, encodeFunctionData, getAddress, hexToBytes, parseAbiItem, zeroAddress } from "viem";
import { type QueuedView, harborCommitment, ops, readAccount, signExitTx } from "./account.ts";
import { publicClient } from "./chain.ts";
import { DEVNET, RpcError, genesisHash, rpcBatch, sleep, withTimeout } from "./devnet.ts";
import { type Call, type Fees, type FrameReceipt, type FrameTx, accountAbi, encodeTx, exitAbi, framesSucceeded, leafNonceKey, maxGas, profile, receiptOf, sendAlt, sendCanonical, simulateFrames, txHash } from "./frame.ts";
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
 *
 * `SWEEP_GAS` bounds execution and not state gas, which is one pool for the frame, and a transfer that succeeds keeps what it spent. A token
 * sweeps before the harbor is paid, so three new slots a token are allowed for. A configured token that takes more can still halt the frame:
 * see docs/FINDINGS.md section 23.
 */
export function rescueCall(harbor: Address, harborSalt: Hex, tokens: number, extra: Address[] = []): Call {
  const call = ops.escape(harbor, harborSalt, extra);
  return { ...call, execution: call.execution + 600_000n * BigInt(tokens), state: call.state + 300_000n * BigInt(tokens) };
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
  if (!Number.isSafeInteger(file.marginSeconds) || file.marginSeconds <= 0) throw new RescueInvalid("its margin is not a number of seconds");
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
  /** `copy` when what landed is not these bytes: a padded copy does the same job, under another hash. */
  | { state: "sent"; hash: Hex; block: number; succeeded: boolean; copy: boolean }
  /** `burns` when sending it would mine, fail and spend the nonce key for nothing. Anything else dies at the door, so it costs nothing to try. */
  | { state: "broken"; reason: string; burns: boolean }
  | { state: "unknown"; reason: string };

/** The one thing that holds a rescue back. Everything else is worth a try: nothing else can stop this now. */
export const wouldBurn = (check: RescueCheck | null) => check?.state === "broken" && check.burns;

/** A read that failed says nothing, so it must not wipe out what a good read knew: that sending this would burn its key. */
export const keepBurn = (now: RescueCheck, before: RescueCheck | null): RescueCheck => (now.state === "unknown" && wouldBurn(before) ? before! : now);

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

/** Errors that are about the request or the node, and say nothing about this transaction. */
const saysNothing = (code: number) => code >= 0 || code === -32700 || (code >= -32603 && code <= -32600);

const ESCAPED = parseAbiItem("event Escaped(address indexed harbor)");

/** The node checks a nonce key and not what spent it, so a spent key proves nothing. Only the money having moved does. */
async function escapeLanded(r: Rescue) {
  const logs = await publicClient.getLogs({ address: r.account, event: ESCAPED, args: { harbor: r.harbor }, fromBlock: 0n, toBlock: "latest" });
  const last = logs.at(-1);
  return last ? { hash: last.transactionHash, block: Number(last.blockNumber) } : null;
}

const RESET: RescueCheck = { state: "broken", burns: false, reason: "This was signed on a chain that has since been reset." };

/** Would this work if sent now? It asks the node and sends nothing. A node that cannot be reached is unknown, and never ready. */
export async function checkRescue(r: Rescue): Promise<RescueCheck> {
  // `genesis` is not signed, so a wrong one says something about the file and proves nothing about the transaction. It is the last word and
  // not the first, so that a forged one cannot hide that a send would burn the key.
  let reset = false;
  try {
    reset = (await genesisHash()) !== r.genesis;
    const receipt = await receiptOf(r.hash);
    if (receipt) return { state: "sent", hash: r.hash, block: Number(BigInt(receipt.blockNumber)), succeeded: framesSucceeded(receipt), copy: false };

    const read = <T>(functionName: string) => publicClient.readContract({ address: r.account, abi: accountV2Abi as never, functionName } as never) as Promise<T>;
    const [named, commitment, reserve, root] = await Promise.all([
      read<Address>("exit"),
      read<Hex>("harborCommitment"),
      publicClient.getBalance({ address: r.exit }),
      publicClient.readContract({ address: r.exit, abi: exitAbi, functionName: "root" }) as Promise<Hex>,
    ]);
    if (getAddress(named) !== r.exit) return { state: "broken", burns: true, reason: "The account no longer names this exit." };
    if (harborCommitment(r.harbor, r.harborSalt) !== commitment) return { state: "broken", burns: true, reason: "The owner changed the harbor after this was signed, so it would fail and move nothing." };
    const leaf = hexToBytes(r.tx.signatures[0]!.signature)[0]!;
    if (leafNonceKey(root, leaf) !== r.tx.nonceKeys[0]) return { state: "broken", burns: false, reason: "The exit's key tree was replaced after this was signed, so this rescue no longer works. Ask the owner for a new one." };

    let sim: Awaited<ReturnType<typeof simulateFrames>> | null = null;
    let failure: string | null = null;
    try {
      sim = await simulateFrames(r.tx);
      if (!sim.frames?.[0]?.succeeded) failure = String(sim.executionError ?? "its VERIFY frame fails");
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      if (saysNothing(error.code) && !/nonce mismatch/i.test(error.message)) throw error;
      failure = error.message;
    }
    if (failure && /nonce mismatch/i.test(failure)) {
      // A copy with the same signature and different padding has another hash and did the job. Another transaction on the same leaf, which a
      // restored signer could sign, spent the same key and moved nothing, and only the chain can tell them apart.
      const landed = await escapeLanded(r);
      if (landed) return { state: "sent", ...landed, succeeded: true, copy: true };
      return { state: "broken", burns: false, reason: "Its one-time key was spent by another transaction, and nothing reached the harbor. Ask the owner for a new one." };
    }
    if (failure) return { state: "broken", burns: false, reason: `It would be refused: ${failure}` };
    const frames = sim!.frames!;
    if (!frames.every((frame) => frame.succeeded)) return { state: "broken", burns: true, reason: `Its SENDER frame would fail, and spend the nonce key: ${sim!.executionError ?? "no reason given"}. Ask the owner for a new one.` };
    if (reserve < r.maxCost) return { state: "broken", burns: false, reason: `The exit holds ${reserve} wei, and this can cost up to ${r.maxCost}. Anyone can top up ${r.exit}.` };
    if (reset) return RESET;
    return { state: "ready", reserve, maxCost: r.maxCost, verifyGas: Number(BigInt(frames[0]!.gasUsed)), totalGas: Number(BigInt(sim!.gasUsed ?? "0x0")) };
  } catch (error) {
    return reset ? RESET : { state: "unknown", reason: (error as Error).message };
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
  /** The margin really used. The file's is not signed, so one that makes no sense is replaced. */
  margin: number;
  /** How old the newest block is, if that is too old to trust a quiet queue. Zero on a healthy chain. */
  staleBy: number;
}

const QUEUE_PAGE = 100;
/** Blocks are seconds apart. Past this, the node has stopped, or fallen behind, and a queue it shows as quiet may not be. */
const STALE_SECONDS = 120;
/** How long a head can sit still before this stops trusting its clock. */
const STALLED_SECONDS = 30;
/** The head last seen to change, and when, by this machine's clock. */
let head: { hash: Hex; at: number } | null = null;

/** On a frozen account only a recovery can leave. A recovery has no recipient, so only those are asked about, in pages: a flood outlives a freeze. */
async function recoveriesAmong(account: Address, items: QueuedView[]): Promise<QueuedView[]> {
  const suspects = items.filter((item) => item.recipient === zeroAddress);
  const found: QueuedView[] = [];
  for (let at = 0; at < suspects.length; at += QUEUE_PAGE) {
    const page = suspects.slice(at, at + QUEUE_PAGE);
    const calls = page.map((item) => ({ method: "eth_call", params: [{ to: account, data: encodeFunctionData({ abi: accountV2Abi as never, functionName: "isRecovery", args: [item.id] } as never) }, "latest"] }));
    const answers = await rpcBatch<Hex>(DEVNET.execution, calls);
    answers.forEach((answer, i) => {
      if (BigInt(answer) !== 0n) found.push(page[i]!);
    });
  }
  return found;
}

/**
 * The switch: is something about to leave that nobody has answered? An answer ends an item: **Not me** cancels it, and **Pay, it's me**
 * cancels it and pays it. So an item still waiting at the margin means the owner is not there.
 *
 * A freeze stops a spend from maturing and does not stop a recovery, so on a frozen account only a recovery counts. Throws if the chain
 * cannot be read: an unknown queue must never look like an empty one.
 */
export async function rescueDue(r: Rescue, margin: number = r.marginSeconds): Promise<RescueDue> {
  const [view, block, delay] = await Promise.all([
    readAccount(r.account),
    publicClient.getBlock(),
    publicClient.readContract({ address: r.account, abi: accountV2Abi as never, functionName: "queueDelay" } as never) as Promise<bigint>,
  ]);
  // A head that stops moving stops the chain's clock with it, and a theft on the real chain does not wait for this node. So time spent stuck
  // counts, measured as time elapsed here, which a wrong date on this machine does not change.
  if (head?.hash !== block.hash) head = { hash: block.hash!, at: Date.now() };
  const stalled = Math.floor((Date.now() - head.at) / 1000);
  const now = Number(block.timestamp) + (stalled > STALLED_SECONDS ? stalled : 0);
  // Not signed, so it can be anything. Nothing at all fires when the thief can already collect, and as long as the delay fires before the owner can answer.
  const queueDelay = Number(delay);
  const usable = Number.isSafeInteger(margin) && margin > 0 && margin < queueDelay ? margin : defaultMargin(queueDelay);
  let waiting = view.items.filter((item) => item.state === 1);
  if (view.frozen) waiting = await recoveriesAmong(r.account, waiting);
  // Not a spread: past about 125,000 items that throws, and a thief can queue that many.
  let soonest: number | null = null;
  for (const item of waiting) {
    const at = Number(item.executeAfter);
    if (soonest === null || at < soonest) soonest = at;
  }
  const sendIn = soonest === null ? null : soonest - usable - now;
  const age = Math.floor(Date.now() / 1000) - Number(block.timestamp);
  return { now, frozen: view.frozen, waiting, soonest, sendIn, due: sendIn !== null && sendIn <= 0, margin: usable, staleBy: age > STALE_SECONDS ? age : 0 };
}

/** When the last good read says to go, on this machine's clock. Worked out from the chain's own time, so a wrong date here does not move it. */
export const sendAtFrom = (due: RescueDue, at: number = Date.now()) => (due.sendIn === null ? null : at + due.sendIn * 1000);

/**
 * Whether to send now. A read that failed is not an answer: if the last good read said when to go and that time has passed, it goes. A
 * rescue nobody needed costs the owner a frozen account, and a theft costs everything.
 */
export function timeToSend(a: { check: RescueCheck | null; due: RescueDue | null; lastSendAt: number | null }, at: number = Date.now()): boolean {
  if (wouldBurn(a.check)) return false;
  if (a.due) return a.due.due;
  return a.lastSendAt !== null && at >= a.lastSendAt;
}

/** How long each mempool gets to take the bytes, and the alt mempool to land them, before the other is asked. It can take four relays to drop one. */
const ALT_PATIENCE_MS = 20_000;
/** One look for a receipt. A hung node must not use up what a send has left. */
const LOOK_MS = 10_000;
/** How a node or the sidecar says it already holds these bytes, which is as good as taking them. */
const HELD = /already known|already in the pool|underpriced/i;

/** A read that fails says nothing about the transaction, so this only looks again. */
async function landed(hash: Hex, ms: number): Promise<FrameReceipt | null> {
  const deadline = Date.now() + ms;
  do {
    const receipt = await withTimeout(receiptOf(hash), LOOK_MS, "the receipt").catch(() => null);
    if (receipt) return receipt;
    await sleep(1000);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Sends the same bytes through whichever mempool takes them. The alt mempool first, then the canonical one, which also takes an exit's
 * transaction with a thief's pending: the sender is not the account. There is nothing to re-sign, and nothing else to try.
 *
 * Nothing here waits on a read before sending, because this is for when reads may be failing: a dead node must not stop the sidecar being
 * asked. Down, refusing, or holding it and not relaying it all mean the same. If both mempools hold the bytes, one landing is the other landing,
 * and which one carried it cannot be told.
 */
export async function sendRescue(r: Rescue, o: { log?: (line: string) => void; timeoutMs?: number; patienceMs?: number } = {}) {
  const log = o.log ?? (() => {});
  const timeoutMs = o.timeoutMs ?? 120_000;
  const patience = Math.min(o.patienceMs ?? ALT_PATIENCE_MS, ALT_PATIENCE_MS, timeoutMs / 2);
  const deadline = Date.now() + timeoutMs;

  let held = false;
  try {
    await withTimeout(sendAlt(r.tx), patience, "the alt mempool");
    held = true;
    log(`admitted by the alt mempool: ${r.hash}`);
  } catch (error) {
    const message = (error as Error).message;
    if (HELD.test(message)) held = true;
    else log(`the alt mempool did not carry it: ${refusal(message)}. Trying the canonical mempool`);
  }
  if (held) {
    const receipt = await landed(r.hash, patience);
    if (receipt) return { hash: r.hash, receipt, route: "alt" as const };
    log(`the alt mempool did not carry it in ${Math.round(patience / 1000)} seconds. Trying the canonical mempool as well`);
  }
  try {
    await withTimeout(sendCanonical(r.tx), patience, "the canonical mempool");
  } catch (error) {
    if (!held && !HELD.test((error as Error).message)) throw error;
  }
  const receipt = await landed(r.hash, Math.max(deadline - Date.now(), 0));
  if (receipt) return { hash: r.hash, receipt, route: held ? ("either" as const) : ("canonical" as const) };
  throw new Error(`${r.hash} was sent and not mined in time`);
}
