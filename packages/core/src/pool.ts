/**
 * What a pool hides, read from the chain and from nothing else, so that anyone can check it and it needs no key.
 *
 * It says three kinds of thing, and keeps them apart: what the chain shows, what this read could not find out, and what no chain can show.
 * The number of addresses is a ceiling on the number of people and never a floor, and a read that failed is unknown, not zero. There is no
 * top setting: a count of addresses cannot show that they are different people, so nothing here ever says the pool hides you well.
 */
import { type Address, type Hex, encodeFunctionData, parseAbiItem } from "viem";
import { publicClient } from "./chain.ts";
import { DEVNET, RpcError, rpc, rpcBatch } from "./devnet.ts";
import { accountV2Abi } from "./zk.ts";

const shielded = parseAbiItem("event Shielded(uint256 indexed commitment, uint256 leaf, uint256 root)");
const unshielded = parseAbiItem("event Unshielded(uint256 indexed nullifierHash, address indexed recipient)");
const unpaid = parseAbiItem("event UnshieldUnpaid(uint256 indexed nullifierHash, address indexed recipient)");

export interface PoolFacts {
  account: Address;
  closed: boolean;
  /** Who sent each deposit, in the order of the tree. Null where the chain did not answer. */
  depositors: (Address | null)[];
  /** Notes spent, whether or not the recipient took the money. */
  withdrawn: number;
  /** Notes whose recipient refused, with the money still held for them. */
  owed: number;
}

/** A transaction's sender never changes, so each is read once. */
const senders = new Map<Hex, Address>();

async function sendersOf(hashes: Hex[]): Promise<(Address | null)[]> {
  const missing = [...new Set(hashes.filter((hash) => !senders.has(hash)))];
  const answers = await rpcBatch<{ from?: Address } | null>(DEVNET.execution, missing.map((hash) => ({ method: "eth_getTransactionByHash", params: [hash] }))).catch(() => missing.map(() => null));
  answers.forEach((tx, i) => {
    if (tx?.from) senders.set(missing[i]!, tx.from);
  });
  return hashes.map((hash) => senders.get(hash) ?? null);
}

/** An account with no pool at all reverts, and an address with no code answers nothing. Anything else that fails is a failed read, not an empty pool. */
async function noteCountOf(account: Address): Promise<bigint | null> {
  const data = encodeFunctionData({ abi: accountV2Abi, functionName: "noteCount" });
  try {
    const answer = await rpc<Hex>(DEVNET.execution, "eth_call", [{ to: account, data }, "latest"]);
    return answer === "0x" ? null : BigInt(answer);
  } catch (error) {
    if (error instanceof RpcError && /revert/i.test(error.message)) return null;
    throw error;
  }
}

/**
 * Null when the account has no pool. Throws when the chain did not answer, and when its answers do not add up, and the caller has to show
 * either as unknown: a node that drops logs would otherwise give a confident wrong number. What is owed comes out of `poolHeld` for the same
 * reason, so the logs have to agree with the money. It also means bytes with no claims, where a refused payment is simply gone, owe nothing.
 */
export async function readPoolFacts(account: Address): Promise<PoolFacts | null> {
  const count = await noteCountOf(account);
  if (count === null) return null;
  const read = <T>(functionName: string) => publicClient.readContract({ address: account, abi: accountV2Abi as never, functionName } as never) as Promise<T>;
  const logs = (event: typeof shielded | typeof unshielded | typeof unpaid) => publicClient.getLogs({ address: account, event, fromBlock: 0n, toBlock: "latest" });
  const [closed, held, denomination, fee, deposits, paid, refused] = await Promise.all([
    read<boolean>("poolClosed"),
    read<bigint>("poolHeld"),
    read<bigint>("DENOMINATION"),
    read<bigint>("MAX_PROOF_TX_COST"),
    logs(shielded),
    logs(unshielded),
    logs(unpaid),
  ]);
  if (BigInt(deposits.length) !== count) throw new Error("the pool's log does not match its count: chain state unknown");
  const withdrawn = paid.length + refused.length;
  const heldForClaims = held - BigInt(deposits.length - withdrawn) * denomination;
  if (!closed && (heldForClaims < 0n || heldForClaims % (denomination - fee) !== 0n)) throw new Error("the pool's log does not add up to what it holds: chain state unknown");
  return { account, closed, depositors: await sendersOf(deposits.map((log) => log.transactionHash!)), withdrawn, owed: closed ? 0 : Number(heldForClaims / (denomination - fee)) };
}

export type PoolState = "empty" | "closed" | "unknown" | "hides nothing" | "hides little";

export interface PoolMeter {
  state: PoolState;
  deposits: number;
  withdrawn: number;
  left: number;
  owed: number;
  /** Notes paid in by each address, the largest first. Null when any deposit's sender is unknown. */
  shares: { address: Address; notes: number; own: boolean }[] | null;
  /** Different addresses that paid in. A ceiling on the number of people, and null when unknown. */
  addresses: number | null;
}

export function poolMeter(facts: PoolFacts): PoolMeter {
  const deposits = facts.depositors.length;
  const left = deposits - facts.withdrawn;
  const known = facts.depositors.every((from) => from !== null);
  const counted = new Map<string, number>();
  for (const from of facts.depositors) if (from) counted.set(from.toLowerCase(), (counted.get(from.toLowerCase()) ?? 0) + 1);
  const shares = known ? [...counted].map(([address, notes]) => ({ address: address as Address, notes, own: address === facts.account.toLowerCase() })).sort((a, b) => b.notes - a.notes) : null;
  const addresses = shares?.length ?? null;
  const state: PoolState = facts.closed ? "closed" : left <= 0 ? "empty" : addresses === null ? "unknown" : addresses === 1 ? "hides nothing" : "hides little";
  return { state, deposits, withdrawn: facts.withdrawn, left, owed: facts.owed, shares, addresses };
}

export interface PoolWords {
  headline: string;
  /** Read off the chain, so anyone can check them. */
  shows: string[];
  /** This read tried, and did not get an answer. */
  unknown: string[];
  /** No read of any chain can answer these. */
  cannotShow: string[];
}

const notes = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;

/** The same words on every surface, because the words are where a meter overstates. */
export function poolWords(meter: PoolMeter): PoolWords {
  const { state, deposits, withdrawn, left, owed, shares, addresses } = meter;
  const own = shares?.find((share) => share.own)?.notes ?? 0;
  const largest = shares?.[0];
  const shows = [`${notes(deposits)} paid in, ${withdrawn} spent, ${left} still in the pool.`];
  if (shares && addresses !== null) {
    shows.push(`Paid in from ${addresses === 1 ? "one address" : `${addresses} addresses`}.${own ? ` ${notes(own)} from this account.` : ""}`);
    if (addresses > 1) shows.push(`The largest paid in ${largest!.notes} of ${deposits}. If every note is as likely to leave, a guess at that address is right about ${largest!.notes} times in ${deposits}.`);
  }
  if (owed > 0) shows.push(`${owed === 1 ? "1 payment" : `${owed} payments`} failed, and the money is still held for ${owed === 1 ? "that note" : "those notes"}, out of reach of a spend.`);
  shows.push("Any withdrawal shows that this account paid that recipient. The pool hides which deposit paid, and not that.");

  const unknown = addresses === null ? ["Who paid in: the chain did not answer for every deposit, so the number of addresses is unknown."] : [];

  const headlines: Record<PoolState, string> = {
    closed: "This pool is closed. An escape took what it held to the harbor, and no note can be spent.",
    empty: deposits === 0 ? "Nothing has been paid in, so there is nothing to hide among." : "Every note has left, so there is nothing to hide among.",
    "hides nothing": own === deposits ? "Hides nothing. Every note came from this account, so a withdrawal is plainly yours." : "Hides nothing. Every note came from one address, so a withdrawal is plainly theirs.",
    unknown: "Unknown. The chain did not say who paid in, so this cannot say what the pool hides.",
    "hides little": `Hides little. A withdrawal could have been paid for by any of at most ${addresses} addresses.`,
  };

  const cannotShow = [
    "Whether those addresses are different people. The real number could be one, so this says at most, and never at least.",
    "Which note left. So nobody can see whose notes are still in.",
    "Your IP address. Sending a transaction shows it to the mempool, and the chain does not record that.",
    "How much timing gives away. A withdrawal soon after a deposit is easy to match, and this does not weigh that.",
  ];
  return { headline: headlines[state], shows, unknown, cannotShow };
}
