/**
 * Measures master-path validation gas on the live client, for docs/GAS.md.
 *
 * Runs `ethrex_simulateFrameTransaction`, which executes the whole transaction against current state and reports
 * per-frame gas even when a limit exceeds the mempool's cap. Nothing lands on chain. The signatures do reach the node,
 * which is why this uses throwaway seeds and in-memory signers, and must never be pointed at a real key.
 */
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ETH,
  MasterSigner,
  WOTS_W16,
  WOTS_W256,
  type WotsParams,
  createAccount,
  deployments,
  harborCommitment,

  memoryStore,
  ops,
  signMasterTx,
  simulate,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";

const SAMPLES = Number(process.env.SAMPLES ?? 24);
const salt = `0x${"11".repeat(32)}` as const;

async function measure(label: string, p: WotsParams, factory: `0x${string}`, verifyGas: bigint) {
  const key = loadOrCreateKey(keyPath("deployer.key"));
  const owner = privateKeyToAccount(key).address;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = new MasterSigner(p, memoryStore(), () => seed);
  const { genesis } = deployments();
  const config = {
    dailyKey: owner,
    wotsRoot: signer.root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(owner, salt),
    queueDelay: 86_400n,
    coolingPeriod: 86_400n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("0.01")],
    coolingAllowances: [parseEther("0.001")],
  };
  const account = await createAccount(key, factory, config, parseEther("0.006"));
  console.log(`\n${label}: account ${account}, ${p.chains} chains, ${p.chains * 32} B signature`);

  const rows: { leaf: number; hashes: number; verify: number; total: number; ok: boolean; violation: string | null }[] = [];
  for (let leaf = 0; leaf < SAMPLES; leaf++) {
    const { tx, hashes } = signMasterTx({ signer, account, epochSalt: genesis, calls: [ops.freeze()], leaf, verifyGas });
    const sim = await simulate(tx);
    const frame = sim.frames?.[0];
    rows.push({ leaf, hashes, verify: frame ? Number(BigInt(frame.gasUsed)) : -1, total: sim.gasUsed ? Number(BigInt(sim.gasUsed)) : -1, ok: !!frame?.succeeded, violation: sim.canonicalMempoolViolation });
  }
  const good = rows.filter((r) => r.ok);
  if (!good.length) return console.log("no successful sample", rows.slice(0, 2));
  const gas = good.map((r) => r.verify).sort((a, b) => a - b);
  const n = good.length;
  const sx = good.reduce((s, r) => s + r.hashes, 0);
  const sy = good.reduce((s, r) => s + r.verify, 0);
  const slope = (n * good.reduce((s, r) => s + r.hashes * r.verify, 0) - sx * sy) / (n * good.reduce((s, r) => s + r.hashes ** 2, 0) - sx ** 2);
  const intercept = (sy - slope * sx) / n;
  console.log(`samples ${n}/${rows.length}  VERIFY gas min ${gas[0]} median ${gas[Math.floor(n / 2)]} max ${gas[n - 1]}`);
  const totals = good.map((r) => r.total).sort((a, b) => a - b);
  console.log(`whole transaction gas median ${totals[Math.floor(n / 2)]}`);
  console.log(`hashes min ${Math.min(...good.map((r) => r.hashes))} max ${Math.max(...good.map((r) => r.hashes))}`);
  console.log(`fit: gas = ${intercept.toFixed(0)} + ${slope.toFixed(1)} per hash`);
  console.log(`canonical verdict on the last sample: ${good.at(-1)!.violation ?? "valid"}`);
}

const d = deployments();
await measure("w=16", WOTS_W16, d.w16.factory, 99_900n);
await measure("w=256", WOTS_W256, d.w256.factory, 1_500_000n);
