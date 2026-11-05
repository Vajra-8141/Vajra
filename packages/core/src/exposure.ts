/**
 * Has this address's public key been exposed?
 *
 * An Ethereum address is a hash of a public key, so the key stays hidden until its owner signs something the chain can
 * see. After that, anyone can recover it, and a large enough quantum computer can go from there to the private key.
 * The verdicts are deliberately not a boolean: a read that failed is `unknown`, never `not exposed`.
 */
import type { Address, Hex } from "viem";
import { rpcBatch } from "./devnet.ts";

export type Exposure = "exposed" | "delegated" | "no-key-on-chain" | "contract" | "unknown";

export interface ExposureReport {
  address: Address;
  verdict: Exposure;
  nonce: bigint | null;
  balance: bigint | null;
}

/** EIP-7702 delegation designator: an EOA that has signed an authorization, so its key is out. */
const DELEGATION_PREFIX = "0xef0100";

export function classifyExposure(a: { address: Address; nonce: bigint; code: Hex; balance: bigint }): ExposureReport {
  const base = { address: a.address, nonce: a.nonce, balance: a.balance };
  if (a.code.toLowerCase().startsWith(DELEGATION_PREFIX)) return { ...base, verdict: "delegated" };
  if (a.code !== "0x") return { ...base, verdict: "contract" };
  return { ...base, verdict: a.nonce > 0n ? "exposed" : "no-key-on-chain" };
}

export async function scanAddress(rpcUrl: string, address: Address): Promise<ExposureReport> {
  try {
    const [nonce, code, balance] = await rpcBatch<Hex>(rpcUrl, [
      { method: "eth_getTransactionCount", params: [address, "latest"] },
      { method: "eth_getCode", params: [address, "latest"] },
      { method: "eth_getBalance", params: [address, "latest"] },
    ]);
    return classifyExposure({ address, nonce: BigInt(nonce!), code: code!, balance: BigInt(balance!) });
  } catch {
    return { address, verdict: "unknown", nonce: null, balance: null };
  }
}

export const EXPOSURE_TEXT: Record<Exposure, { title: string; detail: string }> = {
  exposed: {
    title: "Exposed",
    detail: "This address has sent a transaction, so its public key is on chain for anyone to recover. A quantum computer could derive the private key from it.",
  },
  delegated: {
    title: "Exposed, delegated",
    detail: "This account signed an EIP-7702 authorization, which puts its public key on chain. Its code does not change that: the key still controls it.",
  },
  "no-key-on-chain": {
    title: "No public key on chain",
    detail: "This address has never sent a transaction, so the chain does not show its key. Off-chain signatures can still have revealed it, and the first transaction it sends will.",
  },
  contract: {
    title: "Contract, depends on its owners",
    detail: "A contract has no key of its own. Whether it is safe depends on whatever keys control it, which this lookup cannot see.",
  },
  unknown: {
    title: "Unknown",
    detail: "The lookup failed, so nothing is claimed about this address. Try again.",
  },
};
