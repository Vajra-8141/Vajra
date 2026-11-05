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

let rpcFetch: typeof fetch = (...args) => fetch(...args);
let sidecarFetch: typeof fetch = rpcFetch;

/**
 * Sends every chain read and write through `fn`. This one setting is what lets a browser put all of its traffic through
 * an anon-rpc worker, so a read cannot quietly go around it.
 *
 * `sidecar` carries calls to the mempool nodes when `fn` cannot. The sidecar refuses a body without a usable content
 * type, and the Nym worker's requests arrive that way. Whoever sets this has to tell the user: those calls leave the
 * private route.
 */
export function setRpcFetch(fn: typeof fetch, options: { sidecar?: typeof fetch } = {}) {
  rpcFetch = fn;
  sidecarFetch = options.sidecar ?? fn;
}

const fetchFor = (url: string) => (url === DEVNET.mempool || url === DEVNET.gateway ? sidecarFetch : rpcFetch);

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetchFor(url)(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!response.ok) throw new RpcError(method, response.status, `HTTP ${response.status} from ${url}`);
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data);
  return body.result as T;
}

export interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * Several calls in one request. Over a mixnet the round trip is the cost, so a page that needs eight values should not
 * make eight trips. Results come back in the order of `calls`, whatever order the node answered in.
 */
export async function rpcBatch<T = unknown>(url: string, calls: RpcCall[]): Promise<T[]> {
  if (calls.length === 0) return [];
  const first = nextId;
  nextId += calls.length;
  const response = await fetchFor(url)(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((call, i) => ({ jsonrpc: "2.0", id: first + i, ...call }))),
  });
  if (!response.ok) throw new RpcError("batch", response.status, `HTTP ${response.status} from ${url}`);
  const replies = (await response.json()) as { id: number; result?: T; error?: { code: number; message: string; data?: unknown } }[];
  if (!Array.isArray(replies)) throw new RpcError("batch", -1, "the node did not answer the batch");
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  return calls.map((call, i) => {
    const reply = byId.get(first + i);
    if (!reply) throw new RpcError(call.method, -1, "the node left this call out of its answer");
    if (reply.error) throw new RpcError(call.method, reply.error.code, reply.error.message, reply.error.data);
    return reply.result as T;
  });
}

/** A read that never returns has to become a failed read, or the page shows a spinner forever instead of saying so. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The chain's genesis hash, mixed into every master digest so a signature cannot outlive a reset. */
export async function genesisHash(url: string = DEVNET.execution): Promise<Hex> {
  const block = await rpc<{ hash: Hex }>(url, "eth_getBlockByNumber", ["0x0", false]);
  return block.hash;
}
