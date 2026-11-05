/** The local process that holds the master key. The dashboard asks it for operations and never sees the seed. */
export const BRIDGE = "http://127.0.0.1:8787";

export interface BridgeStatus {
  signer: "software";
  root: `0x${string}`;
  leavesLeft: number;
  harbor: `0x${string}` | null;
  account: `0x${string}` | null;
  rootMatches: boolean | null;
}

export interface MasterResult {
  hash: `0x${string}`;
  block: number;
  verifyGas: number;
  leaf: number;
  hashes: number;
  leavesLeft: number;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BRIDGE}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? value.error);
  return value as T;
}

export const bridgeStatus = () => call<BridgeStatus>("/status");
export const master = (request: Record<string, string>) => call<MasterResult>("/master", request);
export const createOnBridge = (options: Record<string, string | number>) => call<{ account: `0x${string}` }>("/create", options);
