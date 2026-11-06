/** Reading a VajraAccount, and the master- and daily-key operations a client can ask of it. */
import { type Address, type Hex, concat, decodeEventLog, decodeFunctionResult, encodeFunctionData, hexToBytes, keccak256, zeroAddress, zeroHash } from "viem";
import { publicClient, waitForSuccess, walletFor, LEGACY_GAS_PRICE } from "./chain.ts";
import { DEVNET, rpc, rpcBatch } from "./devnet.ts";
import {
  type Call,
  type Fees,
  type FrameTx,
  accountAbi,
  coSignTx,
  dailyTx,
  exitTx,
  leafNonceKey,
  masterDigest,
  masterTx,
  sigHash,
  signDailyTx,
  stealthTx,
  withMasterSignature,
} from "./frame.ts";
import { ChainStateUnknown, type MasterSigner } from "./signer.ts";
import { type WotsParams, verifyHashCount } from "./wots.ts";
import VajraAccountV2 from "./artifacts/VajraAccountV2.json" with { type: "json" };
import VajraExitFactory from "./artifacts/VajraExitFactory.json" with { type: "json" };
import VajraFactory from "./artifacts/VajraFactory.json" with { type: "json" };
import deployed from "./deployments/1337.json" with { type: "json" };

export interface Deployment {
  implementation: Address;
  factory: Address;
  logW: number;
  len2: number;
}

export interface Deployments {
  chainId: number;
  genesis: Hex;
  w16: Deployment;
  w256: Deployment;
  paymaster: Address;
  announcer: Address;
  registry: Address;
  /** The local mirror only. Both need the patched sidecar's staked budget. */
  paymasters?: { quota: Address; usdc: Address; feeCap: string; usdcPerEth: string };
  /** The local mirror only: everything that needs the patched sidecar. */
  v2?: { implementation: Address; factory: Address; exitImplementation?: Address; exitFactory?: Address; recoveryVerifier: Address; shieldVerifier: Address; poseidon: Address; denomination: string; noteFee: string; workBits: number };
}

let active = deployed as unknown as Deployments;

export const deployments = (): Deployments => active;

/** The local mirror's addresses come from a file its deploy wrote, which a browser bundle cannot import. */
export const useDeployments = (loaded: Deployments) => {
  active = loaded;
};

export interface AccountConfig {
  dailyKey: Address;
  wotsRoot: Hex;
  epochSalt: Hex;
  harborCommitment: Hex;
  queueDelay: bigint;
  coolingPeriod: bigint;
  maxDailyTxCost: bigint;
  assets: Address[];
  dailyLimits: bigint[];
  coolingAllowances: bigint[];
  coSigner?: Address;
  stake?: bigint;
  unstakeDelay?: number;
}

const complete = (config: AccountConfig) => ({ coSigner: zeroAddress, stake: 0n, unstakeDelay: 0, ...config });

/** A stealth account: no daily key, no rulebook, and a master key that needs its co-signer. */
export const stealthConfig = (wotsRoot: Hex, coSigner: Address, epochSalt: Hex): AccountConfig => ({
  dailyKey: zeroAddress,
  wotsRoot,
  epochSalt,
  harborCommitment: zeroHash,
  queueDelay: 0n,
  coolingPeriod: 0n,
  maxDailyTxCost: 0n,
  assets: [],
  dailyLimits: [],
  coolingAllowances: [],
  coSigner,
});

/** The chain holds only this until the escape. */
export const harborCommitment = (harbor: Address, salt: Hex): Hex => keccak256(concat([harbor, salt]));

export const ETH = zeroAddress;

export async function predictAccount(factory: Address, config: AccountConfig): Promise<Address> {
  return (await publicClient.readContract({ address: factory, abi: VajraFactory.abi, functionName: "addressOf", args: [complete(config)] })) as Address;
}

/** Deploys the clone with an ordinary transaction; `value` funds it. */
export async function createAccount(key: Hex, factory: Address, config: AccountConfig, value: bigint): Promise<Address> {
  const address = await predictAccount(factory, config);
  const hash = await walletFor(key).writeContract({
    address: factory,
    abi: VajraFactory.abi,
    functionName: "create",
    args: [complete(config)],
    value,
    gas: 3_000_000n,
    gasPrice: LEGACY_GAS_PRICE,
    type: "legacy",
    chain: undefined,
  });
  await waitForSuccess(hash, "creating the account");
  return address;
}

/** The account's second sender, funded with `reserve`. The master key still has to name it: `opsV2.setExit`. */
export async function createExit(key: Hex, factory: Address, account: Address, root: Hex, epochSalt: Hex, reserve: bigint, stake = 0n): Promise<Address> {
  const address = (await publicClient.readContract({ address: factory, abi: VajraExitFactory.abi, functionName: "addressOf", args: [account, root, epochSalt] })) as Address;
  const hash = await walletFor(key).writeContract({
    address: factory,
    abi: VajraExitFactory.abi,
    functionName: "create",
    args: [account, root, epochSalt, stake, stake === 0n ? 0 : 86_400],
    value: reserve + stake,
    gas: 3_000_000n,
    gasPrice: LEGACY_GAS_PRICE,
    type: "legacy",
    chain: undefined,
  });
  await waitForSuccess(hash, "creating the exit");
  return address;
}

export async function accountState(address: Address) {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi: accountAbi, functionName, args }) as Promise<T>;
  const [dailyKey, wotsRoot, epochSalt, frozen, nextItem, harbor] = await Promise.all([
    read<Address>("dailyKey"),
    read<Hex>("wotsRoot"),
    read<Hex>("epochSalt"),
    read<boolean>("frozen"),
    read<bigint>("nextItem"),
    read<Hex>("harborCommitment"),
  ]);
  return { dailyKey, wotsRoot, epochSalt, frozen, nextItem, harbor };
}

export interface QueuedView {
  id: bigint;
  recipient: Address;
  asset: Address;
  amount: bigint;
  executeAfter: bigint;
  state: number;
}

export interface AccountView {
  dailyKey: Address;
  frozen: boolean;
  balance: bigint;
  limit: bigint;
  allowance: bigint;
  spent: bigint;
  items: QueuedView[];
}

/** The newest items, whatever their state, for a page to show. */
const QUEUE_WINDOW = 12n;
const QUEUE_PAGE = 100;
const WAITING = 1;
const EXECUTED = 2;
const VETOED = 3;
/**
 * For each account, below which id nothing is waiting any more. An item that was executed or vetoed stays that way, on that chain: so the
 * mark keeps the head it was read at, and goes if that block does. A reset can bring back the same address on the same genesis.
 */
const settledBelow = new Map<Address, { below: bigint; block: Hex; hash: Hex }>();

/**
 * Everything a page shows about an account: the newest items, and every older one still waiting. Usually two requests, and the second
 * only when items are queued.
 *
 * Older ones matter. A thief can queue a dozen more behind a theft, in one transaction, and a reader of the newest items alone would
 * never alert on the theft: see docs/FINDINGS.md section 22.
 */
// ponytail: reads every item that might still be waiting on each poll. An index of Queued logs would be cheaper if a thief queues thousands.
export async function readAccount(address: Address): Promise<AccountView> {
  const call = (functionName: string, args: unknown[] = []) => ({
    method: "eth_call",
    params: [{ to: address, data: encodeFunctionData({ abi: accountAbi, functionName, args }) }, "latest"],
  });
  const decode = <T>(functionName: string, data: Hex | undefined) => decodeFunctionResult({ abi: accountAbi, functionName, data: data! }) as T;

  const mark = settledBelow.get(address);
  const [dailyKey, frozen, nextItem, rule, balance, anchor] = await rpcBatch<Hex>(DEVNET.execution, [
    call("dailyKey"),
    call("frozen"),
    call("nextItem"),
    call("rule", [ETH]),
    { method: "eth_getBalance", params: [address, "latest"] },
    ...(mark ? [{ method: "eth_getBlockByNumber", params: [mark.block, false] }] : []),
  ]);
  const next = decode<bigint>("nextItem", nextItem);
  const start = next > QUEUE_WINDOW ? next - QUEUE_WINDOW : 0n;
  const settled = mark && (anchor as unknown as { hash: Hex } | null)?.hash === mark.hash ? mark.below : 0n;
  const from = settled < start ? settled : start;
  const ids = Array.from({ length: Number(next - from) }, (_, i) => from + BigInt(i));
  const read: QueuedView[] = [];
  for (let at = 0; at < ids.length; at += QUEUE_PAGE) {
    const page = ids.slice(at, at + QUEUE_PAGE);
    const answers = await rpcBatch<Hex>(DEVNET.execution, page.map((id) => call("queuedItem", [id])));
    answers.forEach((data, i) => read.push({ id: page[i]!, ...decode<Omit<QueuedView, "id">>("queuedItem", data) }));
  }
  // Only what the chain has finished with counts as settled. `None` is what a replica behind the head says of an item it has not seen yet.
  const open = read.findIndex((item) => item.id >= start || (item.state !== EXECUTED && item.state !== VETOED));
  if (open > 0) {
    const head = await rpc<{ number: Hex; hash: Hex }>(DEVNET.execution, "eth_getBlockByNumber", ["latest", false]);
    settledBelow.set(address, { below: read[open]!.id, block: head.number, hash: head.hash });
  }
  const [, limit, allowance, spent] = decode<readonly [boolean, bigint, bigint, bigint]>("rule", rule);
  return {
    dailyKey: decode<Address>("dailyKey", dailyKey),
    frozen: decode<boolean>("frozen", frozen),
    balance: BigInt(balance!),
    limit,
    allowance,
    spent,
    items: read.filter((item) => item.id >= start || item.state === WAITING),
  };
}

// Gas for each operation's SENDER frame. A new storage slot costs 97,920 state gas on this fork, so `state` has to
// cover every slot the call can create. Unused gas is refunded; these only have to be high enough.
//
// `execution` looks too high for a reason. A CALL carrying value to an address with no account checks for 183,600 of
// *execution* gas that it never spends: ethrex computes a state-gas spill against a reservoir that is always empty in
// a frame, even though the state gas itself comes from the frame's separate pool. Any call that might pay a fresh
// address needs that much headroom left at the moment of the CALL.
const encode = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: accountAbi, functionName, args });

/**
 * Releases a queued payment now, which only the master key can do: one transaction that cancels the item and sends the same
 * payment directly. The two frames are an atomic batch, and that matters. If the item matured and someone executed it first,
 * the veto fails, and without the batch the second frame would still run and pay twice.
 */
export function releaseCalls(item: { id: bigint; recipient: Address; asset: Address; amount: bigint }): Call[] {
  const veto: Call = { ...ops.veto(item.id), atomic: true };
  if (item.asset === ETH) return [veto, { target: item.recipient, value: item.amount, data: "0x", execution: 400_000n, state: 300_000n }];
  const data = encodeFunctionData({
    abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
    functionName: "transfer",
    args: [item.recipient, item.amount],
  });
  return [veto, { target: item.asset, data, execution: 400_000n, state: 300_000n }];
}

export const ops = {
  spend: (asset: Address, recipient: Address, amount: bigint): Call => ({
    data: encode("spend", [asset, recipient, amount]),
    execution: 500_000n,
    state: 700_000n,
  }),
  executeQueued: (id: bigint): Call => ({ data: encode("executeQueued", [id]), execution: 400_000n, state: 300_000n }),
  veto: (id: bigint): Call => ({ data: encode("veto", [id]), execution: 80_000n, state: 100_000n }),
  freeze: (): Call => ({ data: encode("freeze", []), execution: 60_000n, state: 100_000n }),
  unfreeze: (): Call => ({ data: encode("unfreeze", []), execution: 60_000n, state: 100_000n }),
  escape: (harbor: Address, salt: Hex, extra: Address[] = []): Call => ({
    data: encode("escape", [harbor, salt, extra]),
    execution: 700_000n,
    state: 400_000n,
  }),
  rotateRoot: (root: Hex): Call => ({ data: encode("rotateRoot", [root]), execution: 60_000n, state: 100_000n }),
  setDailyKey: (key: Address): Call => ({ data: encode("setDailyKey", [key]), execution: 60_000n, state: 100_000n }),
  setHarbor: (commitment: Hex): Call => ({ data: encode("setHarbor", [commitment]), execution: 60_000n, state: 100_000n }),
  setRule: (asset: Address, limit: bigint, allowance: bigint): Call => ({
    data: encode("setRule", [asset, limit, allowance]),
    execution: 120_000n,
    state: 400_000n,
  }),
};

/**
 * Builds a master transaction that will fit, without signing it.
 *
 * The VERIFY limit has to be fixed before signing, because it is part of what gets signed, while the gas actually needed
 * depends on the digest. A signature cannot be tried against a node first: that would reveal the leaf. So the hash count
 * is read off the digest locally, and if a digest would be too expensive, one unit of a harmless limit changes to draw a
 * new digest. Nothing has been revealed at that point, so this costs nothing but hashing.
 */
export function prepareMasterTx(a: {
  root: Hex;
  leaf: number;
  params: WotsParams;
  account: Address;
  epochSalt: Hex;
  calls: Call[];
  verifyGas?: bigint;
  maxHashes?: number;
  fees?: Fees;
}): { tx: FrameTx; hashes: number; digest: Hex } {
  const nonceKey = leafNonceKey(a.root, a.leaf);
  const limit = a.maxHashes ?? Number.POSITIVE_INFINITY;
  for (let tweak = 0n; tweak < 10_000n; tweak++) {
    const calls = a.calls.map((c, i) => (i === 0 ? { ...c, execution: c.execution + tweak } : c));
    const tx = masterTx({ account: a.account, root: a.root, leaf: a.leaf, calls, verifyGas: a.verifyGas, fees: a.fees });
    const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: a.epochSalt, account: a.account, nonceKey, sigHash: sigHash(tx) });
    const hashes = verifyHashCount(a.params, hexToBytes(digest));
    if (hashes <= limit) return { tx, hashes, digest };
  }
  throw new Error("no digest under the hash limit");
}

/** Prepares a master transaction and signs it with a signer held in this process. */
export function signMasterTx(a: {
  signer: MasterSigner;
  account: Address;
  epochSalt: Hex;
  calls: Call[];
  leaf?: number;
  rotation?: boolean;
  verifyGas?: bigint;
  maxHashes?: number;
  fees?: Fees;
}): { tx: FrameTx; leaf: number; hashes: number; digest: Hex } {
  const leaf = a.leaf ?? a.signer.nextLeaf(a.rotation);
  const { tx, hashes, digest } = prepareMasterTx({ ...a, root: a.signer.root, leaf, params: a.signer.params });
  return { tx: withMasterSignature(tx, a.signer.sign(leaf, digest)), leaf, hashes, digest };
}

/**
 * `validateExit` walks the frames, which `validateMaster` does not, so it has about 18,000 gas less for hashing. The mean digest
 * needs about 500 hashes, so few pass this, and drawing a new one costs a hash.
 */
export const EXIT_MAX_HASHES = 430;

/**
 * Signs a transaction from the account's second sender, with the exit tree. As in `prepareMasterTx`, a digest that would not fit
 * under the VERIFY limit is redrawn before anything is revealed.
 */
export function signExitTx(a: { signer: MasterSigner; exit: Address; account: Address; epochSalt: Hex; calls: Call[]; leaf?: number; maxHashes?: number; verifyGas?: bigint; fees?: Fees }): { tx: FrameTx; leaf: number; hashes: number; digest: Hex } {
  const leaf = a.leaf ?? a.signer.nextLeaf();
  const nonceKey = leafNonceKey(a.signer.root, leaf);
  const limit = a.maxHashes ?? EXIT_MAX_HASHES;
  for (let tweak = 0n; tweak < 10_000n; tweak++) {
    const calls = a.calls.map((c, i) => (i === 0 ? { ...c, execution: c.execution + tweak } : c));
    const tx = exitTx({ exit: a.exit, account: a.account, root: a.signer.root, leaf, calls, verifyGas: a.verifyGas, fees: a.fees });
    const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: a.epochSalt, account: a.exit, nonceKey, sigHash: sigHash(tx) });
    const hashes = a.signer.hashCount(digest);
    if (hashes <= limit) return { tx: withMasterSignature(tx, a.signer.sign(leaf, digest)), leaf, hashes, digest };
  }
  throw new Error("no digest under the hash limit");
}

/** True when the account takes EIP-712 typed data for the daily key. A V1 account has no such function, and takes personal_sign. */
export const takesTypedData = (account: Address): Promise<boolean> =>
  publicClient
    .readContract({ address: account, abi: VajraAccountV2.abi as never, functionName: "eip712Domain" } as never)
    .then(() => true, () => false);

/**
 * Signs a stealth spend: the WOTS signature over the digest, then the co-signature over the signature hash. As in
 * `signMasterTx`, a digest that would not fit is redrawn before anything is revealed.
 */
export async function signStealthSpend(a: {
  signer: MasterSigner;
  coSignerKey: Hex;
  coSigner: Address;
  account: Address;
  epochSalt: Hex;
  paymaster: Address;
  calls: Call[];
  leaf?: number;
  maxHashes?: number;
}): Promise<{ tx: FrameTx; leaf: number; hashes: number }> {
  const leaf = a.leaf ?? a.signer.nextLeaf();
  const limit = a.maxHashes ?? 600;
  for (let tweak = 0n; tweak < 10_000n; tweak++) {
    const calls = a.calls.map((c, i) => (i === 0 ? { ...c, execution: c.execution + tweak } : c));
    const tx = stealthTx({ account: a.account, leaf, paymaster: a.paymaster, coSigner: a.coSigner, calls });
    const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: a.epochSalt, account: a.account, nonceKey: 0n, sigHash: sigHash(tx) });
    const hashes = a.signer.hashCount(digest);
    if (hashes > limit) continue;
    const signed = withMasterSignature(tx, a.signer.sign(leaf, digest));
    return { tx: await coSignTx(signed, a.coSignerKey), leaf, hashes };
  }
  throw new Error("no digest under the hash limit");
}

/** Refuses when the chain's root is not the one this signer holds: unknown is a state of its own, never a guess. */
export async function assertRootMatches(signer: MasterSigner, account: Address): Promise<{ epochSalt: Hex }> {
  const state = await accountState(account);
  if (state.wotsRoot.toLowerCase() !== signer.root.toLowerCase()) throw new ChainStateUnknown(signer.root, state.wotsRoot);
  return { epochSalt: state.epochSalt };
}

export async function signDaily(a: { key: Hex; dailyKey: Address; account: Address; calls: Call[]; fees?: Fees }): Promise<FrameTx> {
  const nonce = BigInt(await publicClient.getTransactionCount({ address: a.account }));
  return signDailyTx(dailyTx({ account: a.account, dailyKey: a.dailyKey, nonce, calls: a.calls, fees: a.fees }), a.key);
}

export function queuedEvents(logs: { topics: Hex[]; data: Hex }[]) {
  return logs.flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: accountAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return event.eventName === "Queued" ? [event.args as unknown as { id: bigint; executeAfter: bigint; reason: number }] : [];
    } catch {
      return [];
    }
  });
}
