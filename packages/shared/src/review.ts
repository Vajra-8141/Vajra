/**
 * Turns the account's raw state into what a person has to see before deciding: who, how much, why it queued, what is odd about it.
 *
 * Everything here is read from the chain, the same way on the phone's service and in the extension. A failed read throws, or comes
 * back null and is shown as unknown. It never comes back as zero, and it never comes back as an empty queue.
 */
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, encodeEventTopics, formatEther, formatUnits, parseAbi } from "viem";
import { ETH, type QueuedView, readAccount } from "@vajra/core/account";
import { accountAbi } from "@vajra/core/frame";
import { DEVNET, RpcError, rpc, rpcBatch } from "@vajra/core/devnet";
import { type Book, type Warning, labelOf, recipientWarnings, shortAddress } from "./addressbook.ts";

export interface ReviewItem {
  id: string;
  kind: "payment" | "recovery";
  recipient: Address;
  label: string | null;
  asset: Address;
  /** The amount with its unit, or the raw amount and the token's address when the token will not say what it is. */
  amountText: string;
  amountRaw: string;
  executeAfter: number;
  secondsLeft: number;
  /** Null when the event could not be read. */
  reason: "over-limit" | "new-payee" | null;
  reasonText: string;
  warnings: Warning[];
  /** One line, as an alert would say it. */
  headline: string;
}

export interface Review {
  account: Address;
  balance: string;
  balanceText: string;
  dailyLimit: string;
  spent: string;
  left: string;
  leftText: string;
  frozen: boolean;
  dailyKey: Address;
  items: ReviewItem[];
  blockTime: number;
}

const token = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const v2 = parseAbi(["function isRecovery(uint256) view returns (bool)"]);
const QUEUED_TOPIC = encodeEventTopics({ abi: accountAbi, eventName: "Queued" })[0] as Hex;

const eth = (wei: bigint) => `${formatEther(wei)} ETH`;

const call = (to: Address, data: Hex) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const read = (functionName: string, args: unknown[] = []) => encodeFunctionData({ abi: accountAbi, functionName, args });

const reverted = (error: unknown) => error instanceof RpcError && /revert/i.test(error.message);

/** Only V2 has recovery. On V1 the call reverts, which answers it. A network failure is a different thing, and it throws. */
async function isRecovery(account: Address, id: bigint): Promise<boolean> {
  try {
    const data = await rpc<Hex>(DEVNET.execution, "eth_call", [{ to: account, data: encodeFunctionData({ abi: v2, functionName: "isRecovery", args: [id] }) }, "latest"]);
    return decodeFunctionResult({ abi: v2, functionName: "isRecovery", data });
  } catch (error) {
    if (reverted(error)) return false;
    throw error;
  }
}

/** Asked one at a time: a token that reverts must only cost its own row. */
async function tokenInfo(asset: Address): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const [symbol, decimals] = await rpcBatch<Hex>(DEVNET.execution, [
      call(asset, encodeFunctionData({ abi: token, functionName: "symbol" })),
      call(asset, encodeFunctionData({ abi: token, functionName: "decimals" })),
    ]);
    return { symbol: decodeFunctionResult({ abi: token, functionName: "symbol", data: symbol! }), decimals: decodeFunctionResult({ abi: token, functionName: "decimals", data: decimals! }) };
  } catch {
    return null;
  }
}

/** Why each item queued, from its event. The node may refuse a wide log query, and then the reason is unknown. */
async function queueReasons(account: Address): Promise<Map<string, 0 | 1> | null> {
  try {
    const logs = await rpc<{ topics: Hex[]; data: Hex }[]>(DEVNET.execution, "eth_getLogs", [{ address: account, topics: [QUEUED_TOPIC], fromBlock: "0x0", toBlock: "latest" }]);
    return new Map(logs.map((log) => [BigInt(log.topics[1]!).toString(), Number(BigInt(`0x${log.data.slice(-64)}`)) as 0 | 1]));
  } catch {
    return null;
  }
}

const REASONS = { 0: "over-limit", 1: "new-payee" } as const;
const REASON_TEXT = { "over-limit": "It is over the daily limit.", "new-payee": "This payee is new and is over the new-payee allowance." };

export function describeItem(a: {
  item: QueuedView;
  book: Book;
  now: number;
  recovery: boolean;
  /** Whether the address was seen before this item made it seen. Null when unknown. */
  seenBefore: boolean | null;
  token: { symbol: string; decimals: number } | null;
  reason: 0 | 1 | null;
}): ReviewItem {
  const { item, book, now } = a;
  const left = Number(item.executeAfter) - now;
  const when = left > 0 ? `in ${Math.ceil(left / 60)} min` : "now";
  const reason = a.reason === null ? null : REASONS[a.reason];
  const base = {
    id: item.id.toString(),
    recipient: item.recipient,
    label: labelOf(book, item.recipient),
    asset: item.asset,
    amountRaw: item.amount.toString(),
    executeAfter: Number(item.executeAfter),
    secondsLeft: left,
    reason,
  };
  if (a.recovery) {
    return {
      ...base,
      kind: "recovery",
      amountText: "new key tree",
      reasonText: "A recovery proof was offered for this account.",
      warnings: [{ code: "first-seen", level: "danger", text: "If you did not start a recovery, someone has your recovery paper." }],
      headline: `Someone is replacing your master key. It takes effect ${when}.`,
    };
  }
  const amountText = item.asset === ETH ? eth(item.amount) : a.token ? `${formatUnits(item.amount, a.token.decimals)} ${a.token.symbol}` : `${item.amount} units of unknown token ${shortAddress(item.asset)}`;
  return {
    ...base,
    kind: "payment",
    amountText,
    reasonText: reason ? REASON_TEXT[reason] : "Why it queued is unknown: the node did not return the event.",
    warnings: recipientWarnings(book, item.recipient, a.seenBefore),
    headline: `${amountText} to ${base.label ?? shortAddress(item.recipient)}. It leaves ${when} unless you stop it.`,
  };
}

/** Throws if the chain cannot be read. A caller must show that as unknown, not as an empty account. */
export async function readReview(account: Address, book: Book): Promise<Review> {
  const view = await readAccount(account);
  const pending = view.items.filter((item) => item.state === 1);
  const [delayData, block] = await Promise.all([
    rpc<Hex>(DEVNET.execution, "eth_call", [{ to: account, data: read("queueDelay") }, "latest"]),
    rpc<{ timestamp: Hex }>(DEVNET.execution, "eth_getBlockByNumber", ["latest", false]),
  ]);
  const delay = decodeFunctionResult({ abi: accountAbi, functionName: "queueDelay", data: delayData }) as bigint;
  const now = Number(BigInt(block.timestamp));
  const reasons = pending.length ? await queueReasons(account) : new Map<string, 0 | 1>();

  const items = await Promise.all(
    pending.map(async (item) => {
      const [recovery, info, seen] = await Promise.all([
        isRecovery(account, item.id),
        item.asset === ETH ? null : tokenInfo(item.asset),
        rpc<Hex>(DEVNET.execution, "eth_call", [{ to: account, data: read("firstSeen", [item.recipient]) }, "latest"]).then(
          (data) => decodeFunctionResult({ abi: accountAbi, functionName: "firstSeen", data }) as bigint,
          () => null,
        ),
      ]);
      // `spend` records a new payee even when it only queues, so the chain says "seen" for the very item under review. The first
      // sighting has to come before this item was queued for the address to count as known.
      const queuedAt = item.executeAfter - delay;
      const seenBefore = seen === null ? null : seen !== 0n && seen < queuedAt;
      return describeItem({ item, book, now, recovery, seenBefore, token: info, reason: reasons ? (reasons.get(item.id.toString()) ?? null) : null });
    }),
  );

  const left = view.limit > view.spent ? view.limit - view.spent : 0n;
  return {
    account,
    balance: view.balance.toString(),
    balanceText: eth(view.balance),
    dailyLimit: view.limit.toString(),
    spent: view.spent.toString(),
    left: left.toString(),
    leftText: eth(left),
    frozen: view.frozen,
    dailyKey: view.dailyKey,
    items,
    blockTime: now,
  };
}

export interface Forecast {
  /** "maybe" means the new-payee allowance decides, and what was already spent against it cannot be read. */
  outcome: "leaves" | "queues" | "maybe" | "refused";
  text: string;
  seenBefore: boolean | null;
  delay: number;
}

/** What `spend` would do with this payment, worked out the way the contract does, before anything is signed. */
export async function forecastSpend(account: Address, p: { asset: Address; recipient: Address; amount: bigint }): Promise<Forecast> {
  const [frozenData, ruleData, seenData, coolingData, delayData, block] = await rpcBatch<Hex | { timestamp: Hex }>(DEVNET.execution, [
    call(account, read("frozen")),
    call(account, read("rule", [p.asset])),
    call(account, read("firstSeen", [p.recipient])),
    call(account, read("coolingPeriod")),
    call(account, read("queueDelay")),
    { method: "eth_getBlockByNumber", params: ["latest", false] },
  ]);
  const decode = <T>(functionName: string, data: unknown) => decodeFunctionResult({ abi: accountAbi, functionName, data: data as Hex }) as T;
  const [configured, limit, allowance, spent] = decode<readonly [boolean, bigint, bigint, bigint]>("rule", ruleData);
  const seen = decode<bigint>("firstSeen", seenData);
  const cooling = decode<bigint>("coolingPeriod", coolingData);
  const delay = Number(decode<bigint>("queueDelay", delayData));
  const now = BigInt((block as { timestamp: Hex }).timestamp);
  const seenBefore = seen !== 0n;
  const wait = `It waits in the public queue for ${Math.ceil(delay / 60)} min, and the master key can cancel it.`;

  if (decode<boolean>("frozen", frozenData)) return { outcome: "refused", text: "The account is frozen, so the daily key cannot spend.", seenBefore, delay };
  if (!configured) return { outcome: "refused", text: "This account has no rule for this token, so the daily key cannot spend it.", seenBefore, delay };

  // `spend` starts the clock on a new payee the moment it first sees one.
  const coolingNow = now < (seen === 0n ? now : seen) + cooling;
  if (coolingNow && p.amount > allowance) return { outcome: "queues", text: `Over the new-payee allowance. ${wait}`, seenBefore, delay };
  if (spent + p.amount > limit) return { outcome: "queues", text: `Over the daily limit. ${wait}`, seenBefore, delay };
  if (coolingNow && seen !== 0n) return { outcome: "maybe", text: `Inside the limit, but this payee is still new. If earlier payments used up its allowance: ${wait}`, seenBefore, delay };
  return { outcome: "leaves", text: "Inside the rules: it leaves at once, and cannot be cancelled.", seenBefore, delay };
}
