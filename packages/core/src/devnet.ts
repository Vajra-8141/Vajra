/** The public EIP-8141 devnet, and a JSON-RPC client that keeps a node's error text intact. */
import type { Address, Hex } from "viem";

const PUBLIC = {
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
};

/**
 * The mirror `stack/up.sh` boots: the same two upstream commits, with the sidecar patched. It has its own chain id, so that
 * nothing recorded against it can be read as a public devnet result.
 */
/** `process.env.NEXT_PUBLIC_…` has to be written out in full, or Next cannot put it in the bundle. */
function readLane(): number {
  try {
    return Number(process.env.NEXT_PUBLIC_VAJRA_LANE || process.env.VAJRA_LANE || 0);
  } catch {
    return 0;
  }
}
const LANE = readLane() * 100;
const LOCAL: typeof PUBLIC = {
  chainId: 13370,
  execution: `http://127.0.0.1:${18545 + LANE}`,
  mempool: `http://127.0.0.1:${14337 + LANE}/rpc/`,
  gateway: `http://127.0.0.1:${14337 + LANE}/rpc/`,
  explorer: `http://127.0.0.1:${18080 + LANE}`,
  stakingRegistry: PUBLIC.stakingRegistry,
  usdc: PUBLIC.usdc,
};

/**
 * True when this process runs against the mirror. A browser has no environment, so Next writes NEXT_PUBLIC_VAJRA_STACK into the
 * bundle at build time, from VAJRA_STACK: see next.config.mjs. Anything else gets the public devnet.
 */
function readStack(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_VAJRA_STACK || process.env.VAJRA_STACK;
  } catch {
    return undefined;
  }
}

export const isLocalStack = readStack() === "local";

export const DEVNET = isLocalStack ? LOCAL : PUBLIC;

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

/** The route every chain read takes, for a client that brings its own transport. */
export const routedFetch: typeof fetch = (...args) => rpcFetch(...args);

const fetchFor = (url: string) => (url === DEVNET.mempool || url === DEVNET.gateway ? sidecarFetch : rpcFetch);

/**
 * How long any node gets to answer. A node that hangs has to become a failed read, or a watcher stuck on it goes on showing its last good
 * state. Long enough for the mixnet, whose first read is slow. A race and not an abort signal, because a route brings its own transport.
 */
export const RPC_TIMEOUT_MS = 120_000;

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  return withTimeout(
    (async () => {
      const response = await fetchFor(url)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
      if (!response.ok) throw new RpcError(method, response.status, `HTTP ${response.status} from ${url}`);
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data);
      return body.result as T;
    })(),
    RPC_TIMEOUT_MS,
    `no answer to ${method}:`,
  );
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
  const replies = await withTimeout(
    (async () => {
      const response = await fetchFor(url)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map((call, i) => ({ jsonrpc: "2.0", id: first + i, ...call }))),
      });
      if (!response.ok) throw new RpcError("batch", response.status, `HTTP ${response.status} from ${url}`);
      return (await response.json()) as { id: number; result?: T; error?: { code: number; message: string; data?: unknown } }[];
    })(),
    RPC_TIMEOUT_MS,
    "no answer to a batch:",
  );
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
