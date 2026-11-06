/**
 * Sponsored transactions: `[only_verify, charge, pay, SENDER..., settle]`, for `QuotaPaymaster` and `UsdcPaymaster`.
 *
 * The account's own frame shrinks to approving execution, and the paymaster takes its cost before the body runs. See
 * contracts/src/paymasters/FramePaymaster.sol.
 */
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, decodeErrorResult, encodeFunctionData, hexToBytes, numberToHex, parseAbi } from "viem";
import { publicClient } from "./chain.ts";
import { DEVNET } from "./devnet.ts";
import { type Call, type Fees, type FrameTx, DEFAULT_FEES, accountAbi, dailyTx, leafNonceKey, masterDigest, masterTx, profile, sigHash, signDailyTx, withMasterSignature } from "./frame.ts";
import type { MasterSigner } from "./signer.ts";
import { verifyHashCount } from "./wots.ts";
import QuotaPaymaster from "./artifacts/QuotaPaymaster.json" with { type: "json" };
import UsdcPaymaster from "./artifacts/UsdcPaymaster.json" with { type: "json" };

export const quotaPaymasterAbi = QuotaPaymaster.abi;
export const usdcPaymasterAbi = UsdcPaymaster.abi;
export const quotaPaymasterBytecode = QuotaPaymaster.bytecode as Hex;

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);

export type Sponsor = { kind: "quota"; paymaster: Address } | { kind: "usdc"; paymaster: Address; usdcPerEth: bigint };

/**
 * `execution`, `state` for each paymaster frame. Unused gas comes back in `settle`, except settle's own limit.
 *
 * The quota shape fits the 100,000 prefix cap with a daily signature, so that what the canonical mempool refuses it for is the
 * storage it reads and not its size: 36,000 + 36,000 + 25,000 + 2,800 for the signature. The USDC shape cannot, since a token
 * transfer alone takes most of that.
 */
export const SPONSOR_LIMITS = {
  quota: { verify: 36_000n, charge: { execution: 36_000n, state: 0n }, pay: 25_000n },
  usdc: { verify: 60_000n, charge: { execution: 160_000n, state: 120_000n }, pay: 40_000n },
  settle: { execution: 100_000n, state: 0n },
  /** Whichever frame approves payment spends the nonce, and a keyed nonce's first use costs 20,000 more. */
  payKeyed: 60_000n,
} as const;

export interface SponsorLimits {
  charge?: { execution: bigint; state: bigint };
  pay?: bigint;
  settle?: { execution: bigint; state: bigint };
}

const SCOPE_EXECUTION = 2;
const SCOPE_MASK = 3;

/** The frame index of `charge`, which `settle` is told. `[only_verify, charge, ...]`. */
export const CHARGE_INDEX = 1n;

const chargeData = (s: Sponsor): Hex =>
  s.kind === "quota"
    ? encodeFunctionData({ abi: quotaPaymasterAbi, functionName: "charge" })
    : encodeFunctionData({ abi: usdcPaymasterAbi, functionName: "collect", args: [s.usdcPerEth] });

/** Turns an unsigned `[VERIFY, SENDER...]` into the sponsored shape, with the account approving execution only. */
export function sponsored(tx: FrameTx, s: Sponsor, limits: SponsorLimits = {}): FrameTx {
  const [verify, ...body] = tx.frames;
  if (!verify) throw new Error("a transaction needs a verify frame");
  const charge = limits.charge ?? SPONSOR_LIMITS[s.kind].charge;
  const settle = limits.settle ?? SPONSOR_LIMITS.settle;
  // The scope is the last word of `validateDaily(scope)` and `validateMaster(scope)`.
  const data = `${verify.data.slice(0, -64)}${numberToHex(SCOPE_EXECUTION, { size: 32 }).slice(2)}` as Hex;
  return {
    ...tx,
    frames: [
      { ...verify, flags: (verify.flags & ~SCOPE_MASK) | SCOPE_EXECUTION, data },
      lib.frame(profile, "DEFAULT", { target: s.paymaster, execution: charge.execution, state: charge.state, data: chargeData(s) }),
      lib.frame(profile, "VERIFY", {
        scope: "PAYMENT",
        target: s.paymaster,
        execution: limits.pay ?? SPONSOR_LIMITS[s.kind].pay,
        data: encodeFunctionData({ abi: quotaPaymasterAbi, functionName: "pay" }),
      }),
      ...body,
      lib.frame(profile, "DEFAULT", {
        target: s.paymaster,
        execution: settle.execution,
        state: settle.state,
        data: encodeFunctionData({ abi: quotaPaymasterAbi, functionName: "settle", args: [CHARGE_INDEX] }),
      }),
    ],
  };
}

/** A daily-key transaction with a paymaster. The wallet form cannot do this: it is pinned to `[VERIFY, SENDER]`, so it needs a key. */
export async function signSponsoredDaily(a: {
  key: Hex;
  dailyKey: Address;
  account: Address;
  calls: Call[];
  sponsor: Sponsor;
  fees?: Fees;
  limits?: SponsorLimits;
  edit?: (tx: FrameTx) => FrameTx;
}): Promise<FrameTx> {
  const nonce = BigInt(await publicClient.getTransactionCount({ address: a.account }));
  const verifyGas = SPONSOR_LIMITS[a.sponsor.kind].verify;
  const tx = sponsored(dailyTx({ account: a.account, dailyKey: a.dailyKey, nonce, calls: a.calls, verifyGas, fees: a.fees ?? DEFAULT_FEES }), a.sponsor, a.limits);
  return signDailyTx(a.edit ? a.edit(tx) : tx, a.key);
}

/** The same for the master key. As in `prepareMasterTx`, a digest that would not fit is redrawn before anything is revealed. */
export function signSponsoredMaster(a: {
  signer: MasterSigner;
  account: Address;
  epochSalt: Hex;
  calls: Call[];
  sponsor: Sponsor;
  maxHashes?: number;
  fees?: Fees;
}): { tx: FrameTx; leaf: number } {
  const leaf = a.signer.nextLeaf();
  const nonceKey = leafNonceKey(a.signer.root, leaf);
  const limit = a.maxHashes ?? 660;
  for (let tweak = 0n; tweak < 10_000n; tweak++) {
    const calls = a.calls.map((c, i) => (i === 0 ? { ...c, execution: c.execution + tweak } : c));
    const tx = sponsored(masterTx({ account: a.account, root: a.signer.root, leaf, calls, fees: a.fees }), a.sponsor, { pay: SPONSOR_LIMITS.payKeyed });
    const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: a.epochSalt, account: a.account, nonceKey, sigHash: sigHash(tx) });
    if (verifyHashCount(a.signer.params, hexToBytes(digest)) > limit) continue;
    return { tx: withMasterSignature(tx, a.signer.sign(leaf, digest)), leaf };
  }
  throw new Error("no digest under the hash limit");
}

/** Today's numbers for an account, from the contract. */
export async function readQuota(paymaster: Address, account: Address) {
  const [quota, day, used] = (await publicClient.readContract({ address: paymaster, abi: quotaPaymasterAbi, functionName: "allowanceOf", args: [account] })) as readonly [bigint, bigint, bigint];
  const remaining = (await publicClient.readContract({ address: paymaster, abi: quotaPaymasterAbi, functionName: "remaining", args: [account] })) as bigint;
  return { quota, day, used, remaining };
}

/** The price, with what it is. A number the owner set is never shown without saying so. */
export async function readPrice(paymaster: Address) {
  const read = <T>(functionName: string) => publicClient.readContract({ address: paymaster, abi: usdcPaymasterAbi, functionName }) as Promise<T>;
  const [usdcPerEth, label] = await Promise.all([read<bigint>("usdcPerEth"), read<string>("PRICE_LABEL")]);
  return { usdcPerEth, label };
}

const REFUSAL_ABIS = [quotaPaymasterAbi, usdcPaymasterAbi, accountAbi];

/** A revert's own name, from whichever of our contracts it came from, or null if it is none of theirs. */
export function decodeRefusal(data: Hex): string | null {
  for (const abi of REFUSAL_ABIS) {
    try {
      return decodeErrorResult({ abi, data }).errorName;
    } catch {}
  }
  return null;
}

/** `refusalName`, for a transaction with a paymaster in it. */
export function sponsorRefusal(message: string): string {
  const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined;
  return (data && decodeRefusal(data)) || message;
}
