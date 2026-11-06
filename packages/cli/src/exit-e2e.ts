/**
 * The second route, end to end, on the mirror: a sender of its own for one account, and every way a thief might get at it. Each
 * attack is really sent, and has to die with the name shown. Exits non-zero if anything differs from the claim.
 */
import { writeFileSync } from "node:fs";
import { type Hex, decodeErrorResult, encodeFunctionData, formatEther, keccak256, parseEther, toHex, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as lib from "@forshtat/hegota-support/tx";
import {
  DEVNET,
  ETH,
  type FlatProof,
  type FrameTx,
  RpcError,
  accountState,
  accountV2Abi,
  createExit,
  dailyTx,
  deployments,
  exitAbi,
  exitTx,
  framesSucceeded,
  isLocalStack,
  leafNonceKey,
  masterDigest,
  ops,
  opsV2,
  profile,
  publicClient,
  receiptOf,
  recoveryGate,
  recoveryTicket,
  recoveryTx,
  sendAlt,
  sendCanonical,
  sigHash,
  signDaily,
  signDailyTx,
  signExitTx,
  simulate,
  sleep,
  txHash,
  withMasterSignature,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { proveRecovery, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";
import { V2_STAKE } from "./wallet.ts";
import { check, evidence, master, mined, newAccount, newSigner, refused, refusals, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this is an attack: it runs on the local mirror only, with VAJRA_STACK=local");

const started = Date.now();
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const { v2 } = deployments();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const dailyKey = generatePrivateKey();
const daily = privateKeyToAccount(dailyKey).address;
const signer = newSigner();
const exitTree = newSigner();
const harbor = fresh();
const harborSalt = keccak256(toHex("harbor"));
const account = await newAccount(deployer, signer, daily, harbor, harborSalt, parseEther("2"));
const { epochSalt } = await accountState(account);
const read = <T>(functionName: string, args: unknown[] = []) => publicClient.readContract({ address: account, abi: accountV2Abi as never, functionName, args } as never) as Promise<T>;
const readExit = <T>(functionName: string) => publicClient.readContract({ address: exit, abi: exitAbi as never, functionName } as never) as Promise<T>;
const signed = (calls: Parameters<typeof signExitTx>[0]["calls"], leaf?: number) => signExitTx({ signer: exitTree, exit, account, epochSalt, calls, leaf }).tx;

/** The exit's error names are its own, so `refused` is given them through the node's raw data. */
async function refusedByExit(attack: string, tx: FrameTx, want: string) {
  try {
    const hash = await sendAlt(tx);
    check(false, `${attack}: ADMITTED ${hash}`);
    refusals.push({ attack, refusal: "ADMITTED" });
  } catch (error) {
    const message = error instanceof RpcError ? error.message : String(error);
    const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined;
    const name = data ? decodeErrorResult({ abi: exitAbi, data }).errorName : message;
    check(name === want, `${attack}: ${name === want ? name : `${message.slice(0, 200)} (wanted ${want})`}`);
    refusals.push({ attack, refusal: name.slice(0, 200) });
  }
}

/** Admitted, because the frame is what fails, so this asks the node what would happen instead of spending a leaf's worth of reserve. */
async function refusedInFrame(attack: string, tx: FrameTx) {
  const outcome = await simulate(tx);
  check(outcome.frames?.[1]?.succeeded === false, `${attack}: its frame fails, NotAuthorized`);
  refusals.push({ attack, refusal: "NotAuthorized, in the SENDER frame" });
}

console.log("\n1. The owner sets it up");
const exit = await createExit(deployer, v2!.exitFactory!, account, exitTree.root, epochSalt, parseEther("0.05"), V2_STAKE);
console.log(`  exit ${exit}, ${formatEther(await publicClient.getBalance({ address: exit }))} ETH of its own`);
const early = signed([ops.freeze()]);
await mined("name the exit, master key", master(signer, account, epochSalt, [opsV2.setExit(exit)]));
check((await read<string>("exit")).toLowerCase() === exit.toLowerCase(), "the account names it");

console.log("\n2. The daily key tries to reach it");
await refused("Daily key names an exit of its own", await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [opsV2.setExit(fresh())] }), "EscapeKeyOutranks");
const replaceTree = encodeFunctionData({ abi: exitAbi, functionName: "setRoot", args: [keccak256(toHex("thief tree"))] });
await refused("Daily key replaces the exit's tree", await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [{ data: replaceTree, target: exit, execution: 60_000n, state: 100_000n }] }), "FrameNotAllowed");
const asExit = (tx: FrameTx) => signDailyTx({ ...tx, sender: exit }, dailyKey);
await refusedByExit(
  "Daily key sends from the exit's address, with a daily VERIFY frame",
  await asExit(dailyTx({ account, dailyKey: daily, nonce: 1n, calls: [ops.spend(ETH, daily, 1n)] })),
  "validation frame 0: reverted",
);

console.log("\n3. Attacks on the exit itself");
const forger = newSigner();
await refusedByExit("A signature from another tree", signExitTx({ signer: forger, exit, account, epochSalt, calls: [ops.freeze()] }).tx, "NonceKeyNotBoundToLeaf");
const onRealKey = (() => {
  const tx = exitTx({ exit, account, root: exitTree.root, leaf: 7, calls: [ops.freeze()] });
  const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt, account: exit, nonceKey: leafNonceKey(exitTree.root, 7), sigHash: sigHash(tx) });
  return withMasterSignature(tx, forger.sign(7, digest));
})();
await refusedByExit("A signature from another tree, on the real tree's nonce key", onRealKey, "BadExitSignature");
const masterOnExit = (() => {
  const tx = exitTx({ exit, account, root: exitTree.root, leaf: 8, calls: [ops.freeze()] });
  const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt, account, nonceKey: leafNonceKey(exitTree.root, 8), sigHash: sigHash(tx) });
  return withMasterSignature(tx, exitTree.sign(8, digest));
})();
await refusedByExit("A real key, signing the account's digest instead of the exit's", masterOnExit, "BadExitSignature");
await refusedByExit("The exit key sends a frame to another contract", signed([{ ...ops.freeze(), target: fresh() }]), "FrameNotAllowed");
await refusedByExit("The exit key tries to unfreeze", signed([ops.unfreeze()]), "FrameNotAllowed");
await refusedByExit("The exit key tries to replace the daily key", signed([ops.setDailyKey(fresh())]), "FrameNotAllowed");
await refusedByExit("The exit key tries to move the harbor", signed([ops.setHarbor(keccak256(toHex("thief harbor")))]), "FrameNotAllowed");
await refusedByExit("The exit key tries a spend", signed([ops.spend(ETH, fresh(), 1n)]), "FrameNotAllowed");
await refusedByExit("The exit key tries to move value in a frame", signed([{ ...ops.freeze(), value: 1n }]), "FrameNotAllowed");

console.log("\n4. It works");
const queued = await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [ops.spend(ETH, fresh(), parseEther("0.6"))] });
await mined("the thief queues 0.6 ETH", queued);
const vetoTx = signed([ops.veto(0n)]);
await mined("veto, from the exit", vetoTx);
check((await read<{ state: number }>("queuedItem", [0n])).state === 3, "the item is vetoed");
await refusedByExit("The same leaf again", { ...vetoTx, nonceSeq: 1n }, "LeafAlreadySpent");
await mined("freeze, from the exit, signed before it was named", early);
check((await accountState(account)).frozen, "the account is frozen");
await mined("unfreeze, master key", master(signer, account, epochSalt, [ops.unfreeze()]));

console.log("\n5. A recovery from the exit: a proof, and no key");
const paper = randomFieldElement();
const ticket = recoveryTicket(paper);
await mined("set recovery, master key", master(signer, account, epochSalt, [opsV2.setRecovery(await recoveryCommitment(paper), 60n, recoveryGate(ticket))]));
const recoveredTree = newSigner();
const proved = await proveRecovery({ secret: paper, newRoot: recoveredTree.root, account, epochSalt, chainId: DEVNET.chainId });
const viaExit = (over: Partial<Parameters<typeof recoveryTx>[0]> = {}) => recoveryTx({ account, exit, newRoot: recoveredTree.root, nullifier: proved.nullifier, proof: proved.proof, ticket, ...over });
const bent = [...proved.proof] as unknown as bigint[];
bent[0] = bent[0]! + 1n;
await refused("A corrupted proof, through the exit", viaExit({ proof: bent as unknown as FlatProof }), "RecoveryProofInvalid");
await refused("A seen proof, moved onto the attacker's root, through the exit", viaExit({ newRoot: keccak256(toHex("attacker root")) }), "RecoveryProofInvalid");
await refused("A guessed ticket, through the exit", viaExit({ ticket: keccak256(toHex("a guess")) }), "RecoveryGateInvalid");
const honestRecovery = viaExit();
const extra = lib.frame(profile, "SENDER", { target: fresh(), execution: 400_000n, state: 400_000n, value: parseEther("0.01"), data: "0x" });
await refused("A seen proof, with a frame added that pays the attacker from the reserve", { ...honestRecovery, frames: [...honestRecovery.frames, extra] }, "ProofTxShapeInvalid");
await refused("A seen proof, resent with a huge fee to burn the reserve", viaExit({ fees: { maxFeePerGas: 100_000_000_000n } }), "ProofTxCostExceeded");
const starved = { ...honestRecovery, frames: honestRecovery.frames.map((f, i) => (i === 1 ? { ...f, limits: { ...f.limits, execution: 1000n } } : f)) };
await refused("A seen proof, resent with too little gas, to kill it", starved, "ProofTxShapeInvalid");
await refusedByExit("The exit key queues a root with no proof", signed([opsV2.queueRecovery(recoveredTree.root, proved.nullifier)]), "FrameNotAllowed");
const reserveBefore = await publicClient.getBalance({ address: exit });
await mined("recovery, from the exit", honestRecovery);
check((await read<string>("recoveryGate")) === zeroHash, "the gate closed");
check(reserveBefore - (await publicClient.getBalance({ address: exit })) <= parseEther("0.005"), "the exit paid, and no more than the cap on a proof");
await refused("The same proof, from the account", recoveryTx({ account, newRoot: recoveredTree.root, nullifier: proved.nullifier, proof: proved.proof, ticket }), "NullifierSpent");
await stopProver();
const recoveryItem = (await read<bigint>("nextItem")) - 1n;
await refusedInFrame("The exit key cancels a recovery", signed([ops.veto(recoveryItem)]));
await mined("veto it, master key", master(signer, account, epochSalt, [ops.veto(recoveryItem)]));

console.log("\n6. The master key replaces the tree, and takes money back");
const nextTree = newSigner();
const rotate = { data: encodeFunctionData({ abi: exitAbi, functionName: "setRoot", args: [nextTree.root] }), target: exit, execution: 60_000n, state: 100_000n };
const oldLeaf = signed([ops.freeze()]);
await mined("new exit tree, master key", master(signer, account, epochSalt, [rotate]));
check((await readExit<Hex>("root")) === nextTree.root, "the exit holds the new tree");
await refusedByExit("A signature from the old exit tree", oldLeaf, "NonceKeyNotBoundToLeaf");

const reserveTo = fresh();
const takeBack = { data: encodeFunctionData({ abi: exitAbi, functionName: "execute", args: [reserveTo, parseEther("0.001"), "0x"] }), target: exit, execution: 300_000n, state: 300_000n };
await mined("take some of the reserve back, master key", master(signer, account, epochSalt, [takeBack]));
check((await publicClient.getBalance({ address: reserveTo })) === parseEther("0.001"), "the master key can reach the exit's money, and the daily key cannot");
await refused("Daily key takes the reserve", await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [{ ...takeBack, execution: 100_000n, state: 100_000n }] }), "FrameNotAllowed");

console.log("\n7. With a thief transaction pending, on the mempool that blocks the account itself");
const head = await publicClient.getBlockNumber();
while ((await publicClient.getBlockNumber()) === head) await sleep(100);
const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
const pin = await signDailyTx(dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, fresh(), 1n)], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }), dailyKey);
await sendCanonical(pin);
const direct = master(signer, account, epochSalt, [ops.escape(harbor, harborSalt)]);
const blocked = await sendCanonical(direct).then(() => "ADMITTED", (error: Error) => error.message);
check(/other nonce-key domain/.test(blocked), `escape from the account, canonical: ${blocked.slice(0, 100)}`);
const out = signExitTx({ signer: nextTree, exit, account, epochSalt, calls: [ops.escape(harbor, harborSalt)] }).tx;
const hash = await sendCanonical(out);
console.log(`  escape from the exit, canonical: admitted ${hash}`);
let receipt = await receiptOf(txHash(out));
for (let i = 0; i < 40 && !receipt; i++) {
  await sleep(1000);
  receipt = await receiptOf(txHash(out));
}
check(receipt !== null && framesSucceeded(receipt), `the exit's escape mined through the canonical mempool, in block ${receipt ? Number(BigInt(receipt.blockNumber)) : "none"}`);
const verifyGas = receipt ? Number(BigInt(receipt.frameReceipts[0]!.gasUsed)) : 0;
const landed = await publicClient.getBalance({ address: harbor });
check(landed > parseEther("1.9"), `the harbor holds ${formatEther(landed)} ETH`);
check((await accountState(account)).frozen, "the account is frozen");
console.log(`  VERIFY ${verifyGas} gas, ${Number(BigInt(receipt!.gasUsed))} in all, paid by the exit`);

writeFileSync(
  new URL("../../../docs/evidence/exit-latest.json", import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
      chainId: DEVNET.chainId,
      account,
      exit,
      canonicalEscape: { hash, verifyGas, totalGas: Number(BigInt(receipt!.gasUsed)) },
      failures: tally.failures,
      mined: evidence,
      refusals,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\n${evidence.length} mined, ${refusals.length} refused, ${tally.failures} failures, ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(tally.failures ? 1 : 0);
