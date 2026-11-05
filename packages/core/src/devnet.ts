/** The public EIP-8141 devnet, and a JSON-RPC client that keeps a node's error text intact. */
import type { Address, Hex } from "viem";

export const DEVNET = {
  chainId: 1337,
  /** ethrex directly: standard `eth_*`, `ethrex_simulateFrameTransaction`. */
  execution: "https://altmempool.forshtat.com",
  /** The sidecar on the mining host. Frame transactions go here: this is the alt mempool. */
  mempool: "https://altmempool.forshtat.com/rpc",
  /** A second sidecar that gossips to the miner. Observed holding transactions the miner never received. */
  gateway: "https://altmempoolgateway.forshtat.com/rpc",
  explorer: "https://explorer.altmempool.wtf",
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f" as Address,
  usdc: "0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5" as Address,
} as const;

export class RpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data?: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

let nextId = 1;

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!response.ok) throw new RpcError(method, response.status, `HTTP ${response.status} from ${url}`);
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data);
  return body.result as T;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The chain's genesis hash, mixed into every master digest so a signature cannot outlive a reset. */
export async function genesisHash(url: string = DEVNET.execution): Promise<Hex> {
  const block = await rpc<{ hash: Hex }>(url, "eth_getBlockByNumber", ["0x0", false]);
  return block.hash;
}
