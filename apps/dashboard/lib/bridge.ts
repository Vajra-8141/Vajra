/** The local process that holds the master key. The dashboard asks it for operations and never sees the seed. */
export const LANE = Number(process.env.NEXT_PUBLIC_VAJRA_LANE ?? 0);
export const BRIDGE = `http://127.0.0.1:${8787 + LANE * 100}`;

export interface BridgeStatus {
  signer: "software" | "esp32" | "emulator";
  connected: boolean;
  root: `0x${string}` | null;
  leavesLeft: number | null;
  harbor: `0x${string}` | null;
  account: `0x${string}` | null;
  rootMatches: boolean | null;
  nextLeaf: number | null;
  registryWriter: `0x${string}` | null;
}

export interface Signed {
  gas: number;
  hash: `0x${string}`;
}

export interface MasterResult {
  hash: `0x${string}`;
  block: number;
  verifyGas: number;
  leaf: number;
  hashes: number;
  leavesLeft: number;
}

export interface Probe {
  ok: boolean;
  chainId: number | null;
  error: string | null;
}

export interface Health {
  stack: "mirror" | "public";
  expectedChainId: number;
  execution: Probe;
  sidecar: Probe;
  deployed: boolean;
  stale: boolean;
  account: `0x${string}` | null;
  demo: { available: boolean; reason: string | null; dailyKey: `0x${string}` | null };
  demoAccount: { dailyLimit: string; coolingAllowance: string; queueDelay: number; coolingPeriod: number; fund: string } | null;
}

export interface DemoSpend {
  hash: `0x${string}`;
  block: number;
  verifyGas: number;
  to: `0x${string}`;
  amount: string;
  queued: { id: string; reason: number; executeAfter: string } | null;
  signer: "demo";
}

export type AttackGroup = "rank" | "shape" | "outsider";

export interface AttackInfo {
  id: string;
  group: AttackGroup;
  title: string;
  plain: string;
  expected: string;
  takes: string | null;
}

export interface AttackResult {
  id: string;
  at: string;
  outcome: "refused" | "stopped" | "admitted" | "not-run";
  refusal: string | null;
  expected: string;
  asClaimed: boolean | null;
  raw: string | null;
  code: number | null;
  hash: `0x${string}` | null;
  ms: number;
  failedRule: { rule: string; detail: string | null } | null;
  note: string | null;
  steps: string[];
}

export interface Lane {
  name: "canonical" | "alt";
  route: string;
  verdict: "admitted" | "refused";
  raw: string | null;
  code: number | null;
  ms: number;
  mined: { block: number; ok: boolean } | null;
}

export interface FrameRow {
  index: number;
  kind: string;
  limit: string;
  used: string | null;
  source: "receipt" | "simulation" | null;
  status: "ok" | "failed" | null;
}

export interface LabResult {
  id: string;
  at: string;
  hash: `0x${string}`;
  bytes: { keccak: `0x${string}`; size: number };
  sender: string;
  staked: boolean | null;
  simulation: { canonicalValid: boolean | null; violation: string | null };
  lanes: Lane[];
  frames: FrameRow[];
  verifyLimit: string;
  cap: string;
  notes: string[];
}

export interface ExperimentInfo {
  id: string;
  title: string;
  plain: string;
  takes: string;
}

export interface RaceResult {
  at: string;
  attempts: number;
  canonical: { hash: `0x${string}`; route: string };
  alt: { hash: `0x${string}`; route: string; status: string | null; reason: string | null };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BRIDGE}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? value.error);
  return value as T;
}

export const bridgeStatus = () => call<BridgeStatus>("/status");
export const bridgeHealth = () => call<Health>("/health");
export const bridgeSigned = () => call<{ daily: Signed | null; master: Signed | null }>("/signed");
export const master = (request: Record<string, string>) => call<MasterResult>("/master", request);
export const createOnBridge = (options: Record<string, string | number>) => call<{ account: `0x${string}` }>("/create", options);

export const demoSpend = (to: string, amount: string) => call<DemoSpend>("/demo/spend", { to, amount });
export const demoThief = (amount: string) => call<DemoSpend>("/demo/thief", { amount });
export const demoExecute = (id: string) => call<{ hash: `0x${string}`; block: number }>("/demo/execute", { id });
export const demoReset = () => call<{ account: `0x${string}`; harbor: `0x${string}` }>("/demo/reset", {});

export const attackList = () => call<{ attacks: AttackInfo[]; results: Record<string, AttackResult> }>("/attacks");
export const runAttack = (id: string) => call<AttackResult>("/attacks/run", { id });
export const labList = () => call<{ experiments: ExperimentInfo[]; results: Record<string, LabResult> }>("/lab");
export const runLab = (id: string) => call<LabResult>("/lab/run", { id });
export const runRace = () => call<RaceResult>("/lab/race", {});
