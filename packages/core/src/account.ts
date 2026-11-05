/** Reading a VajraAccount, and the master- and daily-key operations a client can ask of it. */
import { readFileSync } from "node:fs";
import { type Address, type Hex, concat, decodeEventLog, encodeFunctionData, keccak256, zeroAddress } from "viem";
import { publicClient, waitForSuccess, walletFor, LEGACY_GAS_PRICE } from "./chain.ts";
import { DEVNET } from "./devnet.ts";
import {
  type Call,
  type Fees,
  type FrameTx,
  accountAbi,
  dailyTx,
  leafNonceKey,
  masterDigest,
  masterTx,
  sigHash,
  signDailyTx,
  withMasterSignature,
} from "./frame.ts";
import { ChainStateUnknown, type MasterSigner } from "./signer.ts";
import VajraFactory from "./artifacts/VajraFactory.json" with { type: "json" };

export interface Deployment {
  implementation: Address;
  factory: Address;
  logW: number;
  len2: number;
}

export function deployments(): { chainId: number; genesis: Hex; w16: Deployment; w256: Deployment } {
  return JSON.parse(readFileSync(new URL("./deployments/1337.json", import.meta.url), "utf8"));
}

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
}

/** The chain holds only this until the escape. */
export const harborCommitment = (harbor: Address, salt: Hex): Hex => keccak256(concat([harbor, salt]));

export const ETH = zeroAddress;

export async function predictAccount(factory: Address, config: AccountConfig): Promise<Address> {
  return (await publicClient.readContract({ address: factory, abi: VajraFactory.abi, functionName: "addressOf", args: [config] })) as Address;
}

/** Deploys the clone with an ordinary transaction; `value` funds it. */
export async function createAccount(key: Hex, factory: Address, config: AccountConfig, value: bigint): Promise<Address> {
  const address = await predictAccount(factory, config);
  const hash = await walletFor(key).writeContract({
    address: factory,
    abi: VajraFactory.abi,
    functionName: "create",
    args: [config],
    value,
    gas: 3_000_000n,
    gasPrice: LEGACY_GAS_PRICE,
    type: "legacy",
    chain: undefined,
  });
  await waitForSuccess(hash, "creating the account");
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

// Gas for each operation's SENDER frame. A new storage slot costs 97,920 state gas on this fork, so `state` has to
// cover every slot the call can create. Unused gas is refunded; these only have to be high enough.
//
// `execution` looks too high for a reason. A CALL carrying value to an address with no account checks for 183,600 of
// *execution* gas that it never spends: ethrex computes a state-gas spill against a reservoir that is always empty in
// a frame, even though the state gas itself comes from the frame's separate pool. Any call that might pay a fresh
// address needs that much headroom left at the moment of the CALL.
const encode = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: accountAbi, functionName, args });

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
 * Builds and signs a master transaction.
 *
 * The VERIFY limit has to be fixed before signing, because it is part of what gets signed, while the gas actually
 * needed depends on the digest. A signature cannot be tried against a node first: that would reveal the leaf. So the
 * hash count is read off the digest locally, and if a digest would be too expensive, one unit of a harmless limit
 * changes to draw a new digest. Nothing has been revealed at that point, so this costs nothing but hashing.
 */
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
  const root = a.signer.root;
  const nonceKey = leafNonceKey(root, leaf);
  const limit = a.maxHashes ?? Number.POSITIVE_INFINITY;
  for (let tweak = 0n; tweak < 10_000n; tweak++) {
    const calls = a.calls.map((c, i) => (i === 0 ? { ...c, execution: c.execution + tweak } : c));
    const tx = masterTx({ account: a.account, root, leaf, calls, verifyGas: a.verifyGas, fees: a.fees });
    const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: a.epochSalt, account: a.account, nonceKey, sigHash: sigHash(tx) });
    const hashes = a.signer.hashCount(digest);
    if (hashes > limit) continue;
    return { tx: withMasterSignature(tx, a.signer.sign(leaf, digest)), leaf, hashes, digest };
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
