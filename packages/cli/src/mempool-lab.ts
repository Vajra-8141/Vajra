/**
 * One signed transaction, offered to both mempools. `vajra pin` prints the blocked escape from here, and the dashboard's mempool
 * panel runs every experiment through the bridge.
 *
 * The canonical path is ethrex's own mempool, which caps a validation prefix at 100,000 gas and holds one nonce domain per sender.
 * The alt path is the sidecar. On the mirror it is patched to keep ERC-8421's budgets per entity: 100,000 unstaked, 1,000,000
 * staked. That is a property of this sidecar and says nothing about the public one.
 */
import { type Hex, keccak256, parseEther, size, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as lib from "@forshtat/hegota-support/tx";
import {
  DEVNET,
  ETH,
  type FrameReceipt,
  type FrameTx,
  LEGACY_GAS_PRICE,
  MAX_VERIFY_GAS,
  MasterSigner,
  RpcError,
  WOTS_W16,
  accountState,
  createAccount,
  dailyTx,
  deployments,
  encodeTx,
  framesSucceeded,
  harborCommitment,
  memoryStore,
  ops,
  profile,
  publicClient,
  receiptOf,
  rpc,
  sendAlt,
  sendCanonical,
  signDailyTx,
  signMasterTx,
  simulate,
  sleep,
  submit,
  txHash,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";

export interface Lane {
  name: "canonical" | "alt";
  /** What was called, so the raw answer below it can be read in context. */
  route: string;
  verdict: "admitted" | "refused";
  /** The node's own words, untouched. Null when it admitted the transaction. */
  raw: string | null;
  code: number | null;
  ms: number;
  mined: { block: number; ok: boolean } | null;
}

export interface FrameRow {
  index: number;
  kind: string;
  /** The gas this frame declared. */
  limit: string;
  /** What it spent, or null when nothing has reported that. Unknown is not zero. */
  used: string | null;
  source: "receipt" | "simulation" | null;
  status: "ok" | "failed" | null;
}

export interface LabResult {
  id: string;
  at: string;
  /** The transaction hash, which is the same whichever mempool sees it. */
  hash: Hex;
  /** Keccak of the signed bytes, and how many there are. */
  bytes: { keccak: Hex; size: number };
  sender: string;
  staked: boolean | null;
  simulation: { canonicalValid: boolean | null; violation: string | null };
  lanes: Lane[];
  frames: FrameRow[];
  /** The sum of the VERIFY frames' declared limits, which is what both mempools measure. */
  verifyLimit: string;
  cap: string;
  notes: string[];
}

const FRAME_KINDS: Record<number, string> = { 0: "DEFAULT", 1: "VERIFY", 2: "SENDER" };
const CANONICAL_ROUTE = "eth_sendRawTransaction, ethrex";
const ALT_ROUTE = "eth_sendFrameTransaction, sidecar";

async function offer(name: Lane["name"], route: string, send: () => Promise<unknown>): Promise<Lane> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    await send();
    return { name, route, verdict: "admitted", raw: null, code: null, ms: ms(), mined: null };
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    return { name, route, verdict: "refused", raw: error.message, code: error.code, ms: ms(), mined: null };
  }
}

async function minedWithin(hash: Hex, ms: number): Promise<FrameReceipt | null> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const receipt = await receiptOf(hash);
    if (receipt) return receipt;
  }
  return null;
}

async function frameRows(tx: FrameTx, receipt: FrameReceipt | null): Promise<FrameRow[]> {
  const simulated = receipt ? null : await simulate(tx).catch(() => null);
  return tx.frames.map((frame, index) => {
    const mined = receipt?.frameReceipts[index];
    const trial = simulated?.frames?.[index];
    return {
      index,
      kind: FRAME_KINDS[frame.mode] ?? `mode ${frame.mode}`,
      limit: frame.limits.execution.toString(),
      used: mined ? BigInt(mined.gasUsed).toString() : trial ? BigInt(trial.gasUsed).toString() : null,
      source: mined ? "receipt" : trial ? "simulation" : null,
      status: mined ? (mined.status === "0x1" ? "ok" : "failed") : trial ? (trial.succeeded ? "ok" : "failed") : null,
    };
  });
}

const verifyLimit = (tx: FrameTx) => tx.frames.filter((f) => f.mode === 1).reduce((sum, f) => sum + f.limits.execution, 0n);

/** What the simulator says, checked against what the mempool then does. Never a substitute for sending. */
const verdictOf = async (tx: FrameTx) => {
  const simulated = await simulate(tx).catch(() => null);
  return { canonicalValid: simulated?.canonicalMempoolValid ?? null, violation: simulated?.canonicalMempoolViolation ?? null };
};

async function report(o: { id: string; tx: FrameTx; staked: boolean | null; simulation: LabResult["simulation"]; lanes: Lane[]; receipt: FrameReceipt | null; notes: string[] }): Promise<LabResult> {
  const encoded = encodeTx(o.tx);
  return {
    id: o.id,
    at: new Date().toISOString(),
    hash: txHash(o.tx),
    bytes: { keccak: keccak256(encoded), size: size(encoded) },
    sender: o.tx.sender,
    staked: o.staked,
    simulation: o.simulation,
    lanes: o.lanes,
    frames: await frameRows(o.tx, o.receipt),
    verifyLimit: verifyLimit(o.tx).toString(),
    cap: MAX_VERIFY_GAS.toString(),
    notes: o.notes,
  };
}

/** Sends to the canonical mempool, then the same transaction to the alt mempool, and watches for a block. */
async function both(tx: FrameTx) {
  const canonical = await offer("canonical", CANONICAL_ROUTE, () => sendCanonical(tx));
  const alt = await offer("alt", ALT_ROUTE, () => sendAlt(tx));
  const receipt = canonical.verdict === "admitted" || alt.verdict === "admitted" ? await minedWithin(txHash(tx), 30_000) : null;
  if (receipt) {
    const mined = { block: Number(BigInt(receipt.blockNumber)), ok: framesSucceeded(receipt) };
    if (canonical.verdict === "admitted") canonical.mined = mined;
    if (alt.verdict === "admitted") alt.mined = mined;
  }
  return { lanes: [canonical, alt], receipt };
}

/** An EOA relaying for itself, with nothing of ours in it, so that the only variable is the declared VERIFY limit. */
const selfRelay = (key: Hex, nonce: bigint, limit: bigint) =>
  lib.signTx(
    profile,
    lib.newTx({
      chainId: DEVNET.chainId,
      sender: privateKeyToAccount(key).address,
      nonceSeq: nonce,
      fees: { maxFeePerGas: 2_000_000_000n },
      signatures: [lib.secp256k1Placeholder(profile)],
      frames: [lib.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: limit }), lib.frame(profile, "SENDER", { target: privateKeyToAccount(key).address, execution: 50_000n })],
    }),
    key,
  );

async function relayExperiment(id: string, o: { limit: bigint; staked: boolean; notes: string[] }) {
  let key: Hex;
  if (o.staked) {
    key = loadOrCreateKey(keyPath("probe.key"));
  } else {
    key = generatePrivateKey();
    const funded = await walletFor(loadOrCreateKey(keyPath("deployer.key"))).sendTransaction({
      to: privateKeyToAccount(key).address,
      value: parseEther("0.05"),
      gas: 500_000n,
      gasPrice: LEGACY_GAS_PRICE,
      type: "legacy",
    });
    await waitForSuccess(funded, "funding the sender");
  }
  const nonce = BigInt(await publicClient.getTransactionCount({ address: privateKeyToAccount(key).address }));
  const tx = await selfRelay(key, nonce, o.limit);
  const simulation = await verdictOf(tx);
  const { lanes, receipt } = await both(tx);
  return report({ id, tx, staked: o.staked, simulation, lanes, receipt, notes: o.notes });
}

export interface PinOutcome {
  account: string;
  pinned: Lane;
  pinPending: boolean;
  result: LabResult;
  harborBalance: bigint;
  frozen: boolean;
}

/**
 * Can a thief holding the daily key keep the master key out of the mempool? The canonical mempool will not hold a keyed
 * transaction next to a pending linear one from the same sender, and the thief can always keep a linear one pending. This tests
 * whether that stops the escape on the canonical path, and whether the alt mempool, which keeps the two nonce domains
 * independent, admits the same escape at the same moment.
 */
export async function pinExperiment(log: (line: string) => void = () => {}): Promise<PinOutcome | { inconclusive: Lane }> {
  const key = loadOrCreateKey(keyPath("deployer.key"));
  const { w16, genesis } = deployments();
  const dailyPrivate = generatePrivateKey();
  const daily = privateKeyToAccount(dailyPrivate).address;
  const harbor = privateKeyToAccount(generatePrivateKey()).address;
  const thief = privateKeyToAccount(generatePrivateKey()).address;
  const salt = keccak256(toHex(`pin ${Date.now()}`));
  const signer = new MasterSigner(WOTS_W16, memoryStore(), () => crypto.getRandomValues(new Uint8Array(32)));

  const account = await createAccount(
    key,
    w16.factory,
    {
      dailyKey: daily,
      wotsRoot: signer.root,
      epochSalt: genesis,
      harborCommitment: harborCommitment(harbor, salt),
      queueDelay: 86_400n,
      coolingPeriod: 86_400n,
      maxDailyTxCost: parseEther("0.01"),
      assets: [ETH],
      dailyLimits: [parseEther("0.001")],
      coolingAllowances: [parseEther("0.0001")],
    },
    parseEther("0.02"),
  );
  log(`account ${account}`);

  const escape = signMasterTx({ signer, account, epochSalt: genesis, calls: [ops.escape(harbor, salt)], maxHashes: 660 }).tx;
  const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
  const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
  log(`base fee ${base}, account nonce ${nonce}`);

  // A real, valid transaction from the thief. On an idle devnet it mines within a slot, so the escape has to be offered
  // inside that same slot; on a busy chain a transaction priced at the base fee can sit for far longer.
  const pin = await signDailyTx(
    dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, thief, 1n)], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }),
    dailyPrivate,
  );

  // Start just after a block lands, for the longest window before the next one.
  const start = await publicClient.getBlockNumber();
  while ((await publicClient.getBlockNumber()) === start) await sleep(200);

  const pinned = await offer("canonical", CANONICAL_ROUTE, () => sendCanonical(pin));
  log(`thief's transaction, canonical mempool: ${pinned.verdict === "admitted" ? "ACCEPTED" : `REFUSED ${pinned.raw}`}`);
  if (pinned.verdict === "refused") return { inconclusive: pinned };
  const pinPending = (await receiptOf(txHash(pin))) === null;
  log(`thief's transaction still pending: ${pinPending}`);

  log("the same signed escape, offered to both mempools while the thief's transaction is pending:");
  const canonical = await offer("canonical", CANONICAL_ROUTE, () => sendCanonical(escape));
  log(`escape, canonical mempool: ${canonical.verdict === "admitted" ? "ACCEPTED" : `REFUSED ${canonical.raw}`}`);

  const started = performance.now();
  const lanes = [canonical];
  let receipt: FrameReceipt | null = null;
  if (canonical.verdict === "refused") {
    const landed = await submit(escape, { log: (l) => log(`  ${l}`) });
    receipt = landed.receipt;
    lanes.push({
      name: "alt",
      route: ALT_ROUTE,
      verdict: "admitted",
      raw: null,
      code: null,
      ms: Math.round(performance.now() - started),
      mined: { block: Number(BigInt(receipt.blockNumber)), ok: framesSucceeded(receipt) },
    });
    log(`escape, alt mempool: mined ${landed.hash} block ${Number(BigInt(receipt.blockNumber))} after ${landed.attempts} attempt(s), all frames ok: ${framesSucceeded(receipt)}`);
  } else {
    lanes.push(await offer("alt", ALT_ROUTE, () => sendAlt(escape)));
    receipt = await minedWithin(txHash(escape), 30_000);
  }

  const result = await report({
    id: "pin",
    tx: escape,
    staked: false,
    // Simulating now would measure a spent nonce, so only the mempools' own answers count here.
    simulation: { canonicalValid: null, violation: null },
    lanes,
    receipt,
    notes: [`The thief's transaction ${txHash(pin)} was ${pinPending ? "still pending" : "already mined"} when the escape was offered.`],
  });
  return { account, pinned, pinPending, result, harborBalance: await publicClient.getBalance({ address: harbor }), frozen: (await accountState(account)).frozen };
}

export interface RaceResult {
  at: string;
  attempts: number;
  canonical: { hash: Hex; route: string };
  /** The sidecar's transaction, and the sidecar's own word on how it ended. */
  alt: { hash: Hex; route: string; status: string | null; reason: string | null };
}

/** The mirror's slot is two seconds. Sending this far into it leaves ethrex a block to land in before the sidecar forwards anything. */
const LATE_IN_SLOT_MS = 1_750;
const RACE_TRIES = 4;

/**
 * How a transaction the alt mempool admitted ends up Cancelled. Two transactions share a nonce: one goes to ethrex, the other to
 * the sidecar. Timing decides it, not fees: the sidecar forwards within about 300 ms, so early in a slot its transaction mines and
 * the other is lost. Late in a slot ethrex's transaction lands first, and the sidecar's revalidation drops its own and says why.
 * The result reports what the sidecar said, whichever way it went.
 */
export async function raceExperiment(log: (line: string) => void = () => {}): Promise<RaceResult> {
  const key = loadOrCreateKey(keyPath("probe.key"));
  const sender = privateKeyToAccount(key).address;
  let result: RaceResult | null = null;
  for (let attempt = 1; attempt <= RACE_TRIES && result?.alt.status !== "Cancelled"; attempt++) {
    const nonce = BigInt(await publicClient.getTransactionCount({ address: sender }));
    const first = await selfRelay(key, nonce, 90_000n);
    const second = await selfRelay(key, nonce, 91_000n);
    const start = await publicClient.getBlockNumber();
    while ((await publicClient.getBlockNumber()) === start) await sleep(50);
    await sleep(LATE_IN_SLOT_MS);
    await sendCanonical(first);
    await sendAlt(second);
    log(`race ${attempt}: ${txHash(first)} to ethrex, ${txHash(second)} to the sidecar`);

    let status: string | null = null;
    let reason: string | null = null;
    for (const end = Date.now() + 15_000; Date.now() < end && status !== "Cancelled" && status !== "OnChain"; await sleep(500)) {
      const record = await rpc<{ entry: { status: string; revertReason?: string } | null }>(DEVNET.mempool, "skandha_explorer_getTransaction", [txHash(second)]).catch(() => null);
      status = record?.entry?.status ?? status;
      reason = record?.entry?.revertReason ?? reason;
    }
    result = { at: new Date().toISOString(), attempts: attempt, canonical: { hash: txHash(first), route: CANONICAL_ROUTE }, alt: { hash: txHash(second), route: ALT_ROUTE, status, reason } };
  }
  return result!;
}

export interface Experiment {
  id: string;
  title: string;
  /** What this one shows, and on which mempool it holds. */
  plain: string;
  takes: string;
  run: (log: (line: string) => void) => Promise<LabResult>;
}

export const experiments: Experiment[] = [
  {
    id: "pin",
    title: "A thief holds the slot, and you escape",
    plain: "The thief keeps a daily transaction pending. Your hash key escape then goes to both mempools.",
    takes: "about 10 seconds, on a throwaway account",
    run: async (log) => {
      const outcome = await pinExperiment(log);
      if ("inconclusive" in outcome) throw new Error(`the thief's transaction was not admitted, so nothing held the slot and this tests nothing: ${outcome.inconclusive.raw}`);
      return outcome.result;
    },
  },
  {
    id: "under-cap",
    title: "Validation under 100,000",
    plain: "An ordinary sender declares 90,000 gas of validation, which fits everywhere.",
    takes: "about 5 seconds",
    run: () => relayExperiment("under-cap", { limit: 90_000n, staked: true, notes: [] }),
  },
  {
    id: "staked-over",
    title: "Staked sender, 400,000 of validation",
    plain: "Over the canonical cap, inside the 1,000,000 a staked entity gets from the mirror's sidecar.",
    takes: "about 5 seconds",
    run: () => relayExperiment("staked-over", { limit: 400_000n, staked: true, notes: [] }),
  },
  {
    id: "unstaked-over",
    title: "Unstaked sender, 400,000 of validation",
    plain: "The same limit from a fresh sender with no stake, whose budget on the mirror's sidecar is 100,000.",
    takes: "about 8 seconds",
    run: () => relayExperiment("unstaked-over", { limit: 400_000n, staked: false, notes: [] }),
  },
  {
    id: "staked-way-over",
    title: "Staked sender, 1,100,000 of validation",
    plain: "Over the staked budget too, so both mempools should say no.",
    takes: "about 3 seconds",
    run: () => relayExperiment("staked-way-over", { limit: 1_100_000n, staked: true, notes: [] }),
  },
];
