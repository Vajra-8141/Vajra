/**
 * The no-setup demo: everything a judge needs without importing a key into a wallet. It exists on the mirror and nowhere else.
 *
 * On the mirror the daily key sits in a file next to the throwaway deployer key, and the bridge signs with it. That key is
 * worthless by design, and the page calls it a demo signer. On the public chain there is no such key and these routes refuse
 * before they touch anything: `mirrorOnly` runs first, with no network, and `assertMirrorChain` then asks the node itself, so a
 * misconfigured process cannot sign for the wrong chain.
 *
 * Every result here is what the chain and the mempool answered. An attack that gets in is reported as admitted.
 */
import { renameSync, existsSync } from "node:fs";
import { type Address, type Hex, isAddress, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  type FrameTx,
  RpcError,
  accountAbi,
  accountState,
  deployments,
  framesSucceeded,
  isLocalStack,
  ops,
  publicClient,
  queuedEvents,
  readAccount,
  refusalNameV2,
  rpc,
  sendAlt,
  signDaily,
  submit,
  txHash,
} from "@vajra/core";
import { type AttackContext, type AttackGroup, attacks } from "./attacks.ts";
import { deploymentsPath, keyPath } from "./deploy.ts";
import { type LabResult, experiments, raceExperiment } from "./mempool-lab.ts";
import { type MasterResult, createWallet, loadWallet, localDailyAddress, localDailyKey, masterSigner, recordSigned, requireWallet, runMasterOp } from "./wallet.ts";

export const MIRROR_CHAIN_ID = 13370;

/** The account `make judge` creates and the page's "start over" makes again. */
export const DEMO_ACCOUNT = { dailyLimit: "0.1", coolingAllowance: "0.01", queueDelay: 120, coolingPeriod: 30, fund: "2" };

export class NotOnMirror extends Error {
  constructor(why: string) {
    super(`the demo signer exists on the local mirror only: ${why}`);
    this.name = "NotOnMirror";
  }
}

export function mirrorOnly() {
  if (!isLocalStack) throw new NotOnMirror("this bridge is not running with VAJRA_STACK=local");
  if (DEVNET.chainId !== MIRROR_CHAIN_ID) throw new NotOnMirror(`configured for chain ${DEVNET.chainId}`);
}

export async function assertMirrorChain() {
  mirrorOnly();
  const id = Number(BigInt(await rpc<Hex>(DEVNET.execution, "eth_chainId")));
  if (id !== MIRROR_CHAIN_ID) throw new NotOnMirror(`the node answers as chain ${id}`);
}

/** One thing at a time: these share the account's linear nonce, and two at once would refuse each other. */
let tail: Promise<unknown> = Promise.resolve();
export function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => {});
  return next;
}

const dailyKeyIsOurs = async (account: Address) => (await accountState(account)).dailyKey.toLowerCase() === localDailyAddress().toLowerCase();

async function demoContext(): Promise<AttackContext> {
  await assertMirrorChain();
  const wallet = requireWallet();
  if (!(await dailyKeyIsOurs(wallet.account))) throw new Error("this account's daily key is not the demo signer's: it was created with your own wallet");
  const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
  return {
    account: wallet.account,
    dailyPrivate: localDailyKey(),
    daily: localDailyAddress(),
    harborSalt: wallet.harborSalt,
    root: (await accountState(wallet.account)).wotsRoot,
    friend: fresh(),
    thief: fresh(),
  };
}

export interface Probe {
  ok: boolean;
  chainId: number | null;
  error: string | null;
}

async function probe(url: string): Promise<Probe> {
  try {
    return { ok: true, chainId: Number(BigInt(await rpc<Hex>(url, "eth_chainId"))), error: null };
  } catch (error) {
    return { ok: false, chainId: null, error: (error as Error).message };
  }
}

/** What the first-run checklist needs. It never throws: a stopped chain is an answer here, not a failure. */
export async function health() {
  const [execution, sidecar] = await Promise.all([probe(DEVNET.execution), probe(DEVNET.mempool)]);
  const wallet = loadWallet();
  const expected = DEVNET.chainId;
  const live = execution.ok ? await rpc<{ hash: Hex }>(DEVNET.execution, "eth_getBlockByNumber", ["0x0", false]).catch(() => null) : null;
  const recorded = isLocalStack && existsSync(deploymentsPath) ? deployments().genesis : null;
  const deployed = isLocalStack ? existsSync(deploymentsPath) : true;
  // A bridge left running across `make judge` holds the old chain's addresses.
  const stale = isLocalStack && live !== null && recorded !== null && recorded !== live.hash;

  let demo: { available: boolean; reason: string | null; dailyKey: Address | null } = { available: false, reason: "the demo signer exists on the local mirror only", dailyKey: null };
  if (isLocalStack && expected === MIRROR_CHAIN_ID) {
    if (execution.chainId !== MIRROR_CHAIN_ID) demo = { available: false, reason: "the mirror is not answering", dailyKey: null };
    else if (stale) demo = { available: false, reason: "this bridge belongs to an older chain", dailyKey: null };
    else if (!wallet) demo = { available: false, reason: "no account yet", dailyKey: null };
    else {
      const ours = await dailyKeyIsOurs(wallet.account).catch(() => null);
      if (ours === null) demo = { available: false, reason: "the account could not be read", dailyKey: null };
      else if (!ours) demo = { available: false, reason: "this account's daily key is your own wallet, so only that wallet can sign", dailyKey: null };
      else demo = { available: true, reason: null, dailyKey: localDailyAddress() };
    }
  }
  return { stack: isLocalStack ? ("mirror" as const) : ("public" as const), expectedChainId: expected, execution, sidecar, deployed, stale, account: wallet?.account ?? null, demo, demoAccount: isLocalStack ? DEMO_ACCOUNT : null };
}

export interface DemoSpend {
  hash: Hex;
  block: number;
  verifyGas: number;
  to: Address;
  amount: string;
  queued: { id: string; reason: number; executeAfter: string } | null;
  signer: "demo";
}

let lastMined: FrameTx | null = null;

async function sendDaily(c: AttackContext, to: Address, amount: string): Promise<DemoSpend> {
  const tx = await signDaily({ key: c.dailyPrivate, dailyKey: c.daily, account: c.account, calls: [ops.spend(ETH, to, parseEther(amount))] });
  const { hash, receipt } = await submit(tx, { log: console.log });
  if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but the spend failed`);
  lastMined = tx;
  const verifyGas = Number(BigInt(receipt.frameReceipts[0]!.gasUsed));
  recordSigned("daily", { gas: verifyGas, hash });
  const [queued] = queuedEvents(receipt.frameReceipts[1]!.logs as { topics: Hex[]; data: Hex }[]);
  return {
    hash,
    block: Number(BigInt(receipt.blockNumber)),
    verifyGas,
    to,
    amount,
    queued: queued ? { id: queued.id.toString(), reason: queued.reason, executeAfter: queued.executeAfter.toString() } : null,
    signer: "demo",
  };
}

const AMOUNT = /^\d{1,4}(\.\d{1,18})?$/;
const checkedAmount = (value: unknown) => {
  if (typeof value !== "string" || !AMOUNT.test(value)) throw new Error("amount must be a number of ETH");
  return value;
};

export async function demoSpend(request: { to?: unknown; amount?: unknown }) {
  const c = await demoContext();
  if (typeof request.to !== "string" || !isAddress(request.to)) throw new Error("to must be an address");
  return sendDaily(c, request.to, checkedAmount(request.amount));
}

/** The demo's thief, as in `vajra thief`: the same daily key, sending far more than the limit to an address nobody has seen. */
export async function demoThief(request: { amount?: unknown }) {
  const c = await demoContext();
  return sendDaily(c, c.thief, checkedAmount(request.amount ?? "0.5"));
}

export async function demoExecute(request: { id?: unknown }) {
  const c = await demoContext();
  if (typeof request.id !== "string" || !/^\d{1,18}$/.test(request.id)) throw new Error("id must be a queue item");
  const tx = await signDaily({ key: c.dailyPrivate, dailyKey: c.daily, account: c.account, calls: [ops.executeQueued(BigInt(request.id))] });
  const { hash, receipt } = await submit(tx, { log: console.log });
  if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but the item did not run`);
  recordSigned("daily", { gas: Number(BigInt(receipt.frameReceipts[0]!.gasUsed)), hash });
  return { hash, block: Number(BigInt(receipt.blockNumber)) };
}

/** A new account, with a new hash key and a new harbor. An escape ends an account for good, so the demo needs a way to go again. */
export async function demoReset() {
  await assertMirrorChain();
  const stamp = Date.now();
  for (const name of ["wallet.json", "signer.json", "last-signed.json"]) {
    const path = keyPath(name);
    if (existsSync(path)) renameSync(path, `${path}.retired-${stamp}`);
  }
  results.clear();
  labResults.clear();
  lastMined = null;
  const harbor = privateKeyToAccount(generatePrivateKey()).address;
  return createWallet({ ...DEMO_ACCOUNT, dailyKey: localDailyAddress(), harbor }).then(({ account, harbor }) => ({ account, harbor }));
}

export interface AttackResult {
  id: string;
  at: string;
  /** refused: it died at the door. stopped: it was caught later, and how is in `note`. admitted: it got in, and that is a bug. */
  outcome: "refused" | "stopped" | "admitted" | "not-run";
  /** The contract's error name when there is one, otherwise the node's message. */
  refusal: string | null;
  expected: string;
  /** Whether the refusal is the one the rulebook claims. A refusal for another reason is shown as that. */
  asClaimed: boolean | null;
  raw: string | null;
  code: number | null;
  hash: Hex | null;
  ms: number;
  /** The sidecar's own record of which rule failed. */
  failedRule: { rule: string; detail: string | null } | null;
  note: string | null;
  steps: string[];
}

interface Admission {
  admission: { checks: { rule: string; verdict: string; detail?: string }[] } | null;
}

async function failedRule(hash: Hex) {
  const record = await rpc<Admission>(DEVNET.mempool, "skandha_explorer_getTransaction", [hash]).catch(() => null);
  const failed = record?.admission?.checks.find((check) => check.verdict === "fail");
  return failed ? { rule: failed.rule, detail: failed.detail ?? null } : null;
}

async function fire(id: string, expected: string, tx: FrameTx, steps: string[] = []): Promise<AttackResult> {
  const started = performance.now();
  const base = { id, at: new Date().toISOString(), expected, hash: txHash(tx), note: null, steps };
  const ms = () => Math.round(performance.now() - started);
  try {
    await sendAlt(tx);
    return { ...base, outcome: "admitted", refusal: null, asClaimed: false, raw: null, code: null, ms: ms(), failedRule: null };
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    const refusal = refusalNameV2(error.message);
    const asClaimed = expected.startsWith("/") ? new RegExp(expected.slice(1, -1), "i").test(refusal) : refusal === expected;
    return { ...base, outcome: "refused", refusal, asClaimed, raw: error.message, code: error.code, ms: ms(), failedRule: await failedRule(txHash(tx)) };
  }
}

const notRun = (id: string, expected: string, note: string): AttackResult => ({
  id,
  at: new Date().toISOString(),
  outcome: "not-run",
  refusal: null,
  expected,
  asClaimed: null,
  raw: null,
  code: null,
  hash: null,
  ms: 0,
  failedRule: null,
  note,
  steps: [],
});

/** Attacks that need the account in a certain state first. Each says what it did to get there. */
const staged: { id: string; group: AttackGroup; title: string; plain: string; expected: string; takes?: string; run: (c: AttackContext) => Promise<AttackResult> }[] = [
  {
    id: "frozen",
    group: "rank",
    title: "a daily spend while frozen",
    plain: "Spends after you hit freeze. This freezes the account for real, tries, then unfreezes it.",
    expected: "AccountFrozen",
    takes: "about 20 seconds, two one-time keys",
    run: async (c) => {
      const steps: string[] = [];
      const wasFrozen = (await accountState(c.account)).frozen;
      if (!wasFrozen) {
        const frozen = await runMasterOp({ op: "freeze" }, console.log);
        steps.push(`froze the account with the hash key, block ${frozen.block}`);
      }
      const tx = await signDaily({ key: c.dailyPrivate, dailyKey: c.daily, account: c.account, calls: [ops.spend(ETH, c.friend, 1n)] });
      const result = await fire("frozen", "AccountFrozen", tx, steps);
      if (!wasFrozen) {
        const unfrozen: MasterResult = await runMasterOp({ op: "unfreeze" }, console.log);
        steps.push(`unfroze the account with the hash key, block ${unfrozen.block}`);
      }
      return result;
    },
  },
  {
    id: "replay",
    group: "shape",
    title: "a mined transaction, replayed byte for byte",
    plain: "Sends a payment that already went through a second time.",
    expected: "/nonce/",
    takes: "about 6 seconds",
    run: async (c) => {
      const steps: string[] = [];
      if (!lastMined || lastMined.sender.toLowerCase() !== c.account.toLowerCase()) {
        const paid = await sendDaily(c, c.friend, "0.000001");
        steps.push(`mined a real payment of 0.000001 ETH to replay, block ${paid.block}`);
      }
      return fire("replay", "/nonce/", lastMined!, steps);
    },
  },
  {
    id: "execute-early",
    group: "shape",
    title: "an early execute of a queued item",
    plain: "Runs a waiting payment before its delay is over. Needs an item in the queue.",
    expected: "QueuedPendingTimelock",
    run: async (c) => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const item = (await readAccount(c.account)).items.find((i) => i.state === 1 && i.executeAfter > now);
      if (!item) return notRun("execute-early", "QueuedPendingTimelock", "Nothing is waiting in the queue, so there is nothing to execute early. Queue a payment first.");
      const started = performance.now();
      const answer = await publicClient.simulateContract({ address: c.account, abi: accountAbi, functionName: "executeQueued", args: [item.id] }).then(
        () => null,
        (e: Error) => e.message,
      );
      const base = { id: "execute-early", at: new Date().toISOString(), expected: "QueuedPendingTimelock", code: null, hash: null, ms: Math.round(performance.now() - started), failedRule: null, steps: [] };
      if (answer === null) return { ...base, outcome: "admitted", refusal: null, asClaimed: false, raw: null, note: `The chain would run item ${item.id} now.` };
      const asClaimed = answer.includes("QueuedPendingTimelock");
      return { ...base, outcome: "stopped", refusal: asClaimed ? "QueuedPendingTimelock" : answer.slice(0, 200), asClaimed, raw: answer, note: `Asked the chain with eth_call on item ${item.id}. Anyone may call this, so it needs no mempool refusal: the contract itself says no.` };
    },
  },
];

const results = new Map<string, AttackResult>();
const labResults = new Map<string, LabResult | { error: string; at: string }>();

export function attackList() {
  const simple = attacks.map(({ id, group, title, plain, expected }) => ({ id, group, title, plain, expected, takes: null as string | null }));
  const others = staged.map(({ id, group, title, plain, expected, takes }) => ({ id, group, title, plain, expected, takes: takes ?? null }));
  return { attacks: [...simple, ...others], results: Object.fromEntries(results) };
}

export async function runAttack(request: { id?: unknown }): Promise<AttackResult> {
  const c = await demoContext();
  const plain = attacks.find((a) => a.id === request.id);
  const special = staged.find((a) => a.id === request.id);
  if (!plain && !special) throw new Error("no such attack");
  const result = plain ? await fire(plain.id, plain.expected, await plain.build(c)) : await special!.run(c);
  results.set(result.id, result);
  console.log(`attack ${result.id}: ${result.outcome} ${result.refusal ?? ""}`);
  return result;
}

export function labList() {
  return { experiments: experiments.map(({ id, title, plain, takes }) => ({ id, title, plain, takes })), results: Object.fromEntries(labResults) };
}

export async function runLab(request: { id?: unknown }) {
  await assertMirrorChain();
  const experiment = experiments.find((e) => e.id === request.id);
  if (!experiment) throw new Error("no such experiment");
  const result = await experiment.run(console.log);
  labResults.set(result.id, result);
  return result;
}

export async function runRace() {
  await assertMirrorChain();
  return raceExperiment(console.log);
}
