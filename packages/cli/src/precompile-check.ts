/**
 * One transaction whose payer calls a precompile in validation, offered to the sidecar as patched and as deployed, for
 * docs/upstream/prs/precompiles-calling-040.md. Needs the mirror and `make unpatched`.
 */
import { readFileSync } from "node:fs";
import * as lib from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { type Hex, encodeFunctionData, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_FEES, ETH, LEGACY_GAS_PRICE, RpcError, Scope, createAccount, dailyTx, deployments, harborCommitment, isLocalStack, ops, profile, publicClient, rpc, sendAlt, signDailyTx, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";

if (!isLocalStack) throw new Error("run this on the mirror, with VAJRA_STACK=local");

const { abi, bytecode } = JSON.parse(readFileSync(new URL("../../core/src/artifacts/PrecompileProbe.json", import.meta.url), "utf8")) as { abi: never; bytecode: Hex };
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const wallet = walletFor(deployer);
const plain = { gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as const;

const probe = (await waitForSuccess(await wallet.deployContract({ abi, bytecode, ...plain }), "placing the probe")).contractAddress!;
await waitForSuccess(await wallet.sendTransaction({ to: probe, value: parseEther("1"), ...plain }), "funding the probe");
// An unstaked payer is enough: this is about the code check, not stake.
console.log(`probe ${probe}, no stake`);

const key = generatePrivateKey();
const daily = privateKeyToAccount(key).address;
const { w16, genesis } = deployments();
const account = await createAccount(
  deployer,
  w16.factory,
  {
    dailyKey: daily,
    wotsRoot: `0x${"11".repeat(32)}`,
    epochSalt: genesis,
    harborCommitment: harborCommitment(daily, `0x${"22".repeat(32)}`),
    queueDelay: 60n,
    coolingPeriod: 0n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("1")],
    coolingAllowances: [parseEther("1")],
  },
  parseEther("0.1"),
);

const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
const base = dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, daily, 1n)], verifyGas: 40_000n, fees: DEFAULT_FEES });
const verify = base.frames[0]!;
const tx = await signDailyTx(
  {
    ...base,
    frames: [
      { ...verify, flags: (verify.flags & ~3) | Scope.Execution, data: `${verify.data.slice(0, -2)}02` as Hex },
      lib.frame(profile, "VERIFY", { scope: "PAYMENT", target: probe, execution: 45_000n, data: encodeFunctionData({ abi: parseAbi(["function pay()"]), functionName: "pay" }) }),
      ...base.frames.slice(1),
    ],
  },
  key,
);

const lane = Number(process.env.VAJRA_LANE ?? 0) * 100;
const unpatched = `http://127.0.0.1:${14338 + lane}/rpc/`;
const answer = (p: Promise<unknown>) => p.then((hash) => `ADMITTED ${hash}`, (error) => (error instanceof RpcError ? error.message : String(error)));
console.log(`sidecar as deployed: ${await answer(rpc(unpatched, "eth_sendFrameTransaction", [toWire(tx)]))}`);
console.log(`sidecar with the patch: ${await answer(sendAlt(tx))}`);
