/**
 * Recovery by proof, end to end, on the local mirror: a fresh account, a commitment, a master key lost on purpose, a proof,
 * a delay, a new root, and a signature from the new tree. Every attack the design claims to stop is attempted against the
 * real client and the patched sidecar. Exits non-zero if anything behaves differently from the claim.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { type Address, formatEther, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as lib from "@forshtat/hegota-support/tx";
import {
  DEVNET,
  ETH,
  type FlatProof,
  LEGACY_GAS_PRICE,
  type MasterSigner,
  accountState,
  accountV2Abi,
  dailyTx,
  deployments,
  isLocalStack,
  leafNonceKey,
  ops,
  opsV2,
  profile,
  publicClient,
  recoveryNonceKey,
  recoveryTx,
  signDaily,
  signDailyTx,
  sleep,
  waitForSuccess,
  walletFor,
  recoveryGate,
  recoveryTicket,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { check, evidence, master, mined, newAccount, newSigner, refusals, refused, reverts, tally } from "./zk-run.ts";
import { proveRecovery, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";

if (!isLocalStack) throw new Error("recovery needs the patched sidecar: run this with VAJRA_STACK=local, after `vajra judge`");

const DELAY = 20n;

const read = <T>(address: Address, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address, abi: accountV2Abi as never, functionName, args } as never) as Promise<T>;

const started = Date.now();
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const { v2 } = deployments();
if (!v2) throw new Error("no V2 deployment on this stack: run `vajra deploy` first");
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const salt = keccak256(toHex("harbor"));
const dailyKey = generatePrivateKey();
const daily = privateKeyToAccount(dailyKey).address;

console.log("\n1. A fresh account, with no recovery set");
let oldTree: MasterSigner | null = newSigner();
const account = await newAccount(deployer, oldTree, daily, harbor, salt);
const { epochSalt, wotsRoot: firstRoot } = await accountState(account);
console.log(`  account ${account}, ${formatEther(await publicClient.getBalance({ address: account }))} ETH`);

const secret = randomFieldElement();
const newTree = newSigner();
const statement = { secret, newRoot: newTree.root, account, epochSalt, chainId: DEVNET.chainId };
const proved = await proveRecovery(statement);
console.log(`  proved in ${proved.ms} ms, verified against the key`);
const tx = (over: Partial<Parameters<typeof recoveryTx>[0]> = {}) => recoveryTx({ account, newRoot: newTree.root, nullifier: proved.nullifier, proof: proved.proof, ticket: recoveryTicket(secret), ...over });
await refused("A proof, before any commitment is set", tx(), "RecoveryNotSet");

console.log("\n2. Set the commitment, with the master key");
await mined("set recovery", master(oldTree, account, epochSalt, [opsV2.setRecovery(await recoveryCommitment(secret), DELAY, recoveryGate(recoveryTicket(secret)))]));
check((await read<bigint>(account, "recoveryDelay")) === DELAY, `delay is ${DELAY}s`);

await refused("A proof with a guessed ticket, which must die for a hash and not a pairing", tx({ ticket: keccak256(toHex("a guess")) }), "RecoveryGateInvalid");

console.log("\n3. The daily key tries to reach recovery");
await refused("Daily key changes the commitment", await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [opsV2.setRecovery(1n, 0n, recoveryGate(recoveryTicket(1n)))] }), "EscapeKeyOutranks");
await refused("Daily key queues a root with no proof", await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [opsV2.queueRecovery(newTree.root, 1n)] }), "EscapeKeyOutranks");

const burnOn = async (nonceKey: bigint) => signDailyTx({ ...dailyTx({ account, dailyKey: daily, nonce: 0n, calls: [ops.spend(ETH, daily, 0n)], verifyGas: 97_000n }), nonceSeq: 0n, nonceKeys: [nonceKey] }, dailyKey);
await refused("Daily key burns a master leaf's nonce key", await burnOn(leafNonceKey(firstRoot, 63)), "DailyNonceKeyInvalid");
await refused("Daily key burns the recovery's nonce key", await burnOn(recoveryNonceKey(proved.nullifier, newTree.root)), "DailyNonceKeyInvalid");

// Signed now, and kept, so the old tree can be tried again once the new root is in.
const oldTreeAttempt = master(oldTree, account, epochSalt, [ops.freeze()]);

console.log("\n4. The master key is lost");
oldTree = null;
console.log("  the old seed is gone from this process; nothing below can sign with it");

console.log("\n5. Attacks on the proof");
const bent = [...proved.proof] as unknown as bigint[];
bent[0] = bent[0]! + 1n;
await refused("A corrupted proof", tx({ proof: bent as unknown as FlatProof }), "RecoveryProofInvalid");
const wrong = await proveRecovery({ ...statement, secret: randomFieldElement() });
await refused("A proof from the wrong secret", tx({ proof: wrong.proof, nullifier: wrong.nullifier }), "RecoveryProofInvalid");
const attackerRoot = keccak256(toHex("attacker root"));
await refused("A seen proof, moved onto the attacker's root", tx({ newRoot: attackerRoot }), "RecoveryProofInvalid");
const other = await proveRecovery({ ...statement, account: privateKeyToAccount(generatePrivateKey()).address });
await refused("A proof made for another account", tx({ proof: other.proof }), "RecoveryProofInvalid");
const otherChain = await proveRecovery({ ...statement, chainId: 1 });
await refused("A proof made for another chain", tx({ proof: otherChain.proof }), "RecoveryProofInvalid");
const otherSalt = await proveRecovery({ ...statement, epochSalt: keccak256(toHex("old epoch")) });
await refused("A proof from another epoch", tx({ proof: otherSalt.proof }), "RecoveryProofInvalid");

const honest = tx();
const extra = lib.frame(profile, "SENDER", { target: privateKeyToAccount(generatePrivateKey()).address, execution: 400_000n, state: 400_000n, value: parseEther("0.5"), data: "0x" });
await refused("A seen proof, with a frame added that pays the attacker", { ...honest, frames: [...honest.frames, extra] }, "ProofTxShapeInvalid");
await refused("A seen proof, resent with a huge fee to burn the balance", tx({ fees: { maxFeePerGas: 100_000_000_000n } }), "ProofTxCostExceeded");
const starve = (limits: { execution?: bigint; state?: bigint }) => ({ ...honest, frames: honest.frames.map((f, i) => (i === 1 ? { ...f, limits: { ...f.limits, ...limits } } : f)) });
await refused("A seen proof, resent with too little execution gas, to kill it", starve({ execution: 1000n }), "ProofTxShapeInvalid");
await refused("A seen proof, resent with too little state gas, to kill it", starve({ state: 0n }), "ProofTxShapeInvalid");
await refused("A seen proof, on a nonce key of the attacker's choosing", { ...honest, nonceKeys: [12345n] }, "ProofTxShapeInvalid");

console.log("\n6. The real recovery");
const { receipt } = await mined("queue recovery", honest);
const id = (await read<bigint>(account, "nextItem")) - 1n;
check(await read<boolean>(account, "isRecovery", [id]), `queue item ${id} is a recovery`);
check((await accountState(account)).wotsRoot === firstRoot, "the root has not changed yet");
console.log(`  VERIFY ${Number(BigInt(receipt.frameReceipts[0]!.gasUsed))} gas, over the deployed sidecar's 100,000 cap, mined through the patched one`);

await refused("The same proof, replayed on the next nonce", { ...honest, nonceSeq: 1n }, "NullifierSpent");

const stranger = walletFor(deployer);
const execute = (item: bigint) =>
  stranger.writeContract({ address: account, abi: accountV2Abi as never, functionName: "executeQueued", args: [item], gas: 3_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never);
await reverts("Installing before the delay", "QueuedPendingTimelock", { address: account, functionName: "executeQueued", args: [id], account: privateKeyToAccount(deployer).address });

console.log(`\n7. The delay passes (${DELAY}s), and anyone installs the root`);
const item = await read<{ executeAfter: bigint }>(account, "queuedItem", [id]);
for (;;) {
  const head = await publicClient.getBlock();
  if (head.timestamp > item.executeAfter) break;
  await sleep(1000);
}
const installed = await waitForSuccess(await execute(id), "installing the root");
evidence.push({ step: "install root", hash: installed.transactionHash, block: Number(installed.blockNumber), verifyGas: 0, totalGas: Number(installed.gasUsed), attempts: 1 });
check((await accountState(account)).wotsRoot.toLowerCase() === newTree.root.toLowerCase(), `installed by an outsider in block ${installed.blockNumber}: root is the new tree`);

console.log("\n8. The old tree is dead, and the new tree signs");
await refused("A signature from the lost tree", oldTreeAttempt, "NonceKeyNotBoundToLeaf");
await mined("freeze, signed by the NEW tree", master(newTree, account, epochSalt, [ops.freeze()]));
check(await read<boolean>(account, "frozen"), "the account obeyed the new tree");
await mined("unfreeze, signed by the NEW tree", master(newTree, account, epochSalt, [ops.unfreeze()]));

console.log("\n9. A stolen paper, with the owner still holding the master key");
const owner = newSigner();
const account2 = await newAccount(deployer, owner, daily, harbor, keccak256(toHex("second")));
const paper = randomFieldElement();
await mined("set recovery on the second account", master(owner, account2, epochSalt, [opsV2.setRecovery(await recoveryCommitment(paper), DELAY, recoveryGate(recoveryTicket(paper)))]));
const thiefRoot = keccak256(toHex("thief tree"));
const theft = await proveRecovery({ secret: paper, newRoot: thiefRoot, account: account2, epochSalt, chainId: DEVNET.chainId });
await mined("thief queues a root, with a stolen paper", recoveryTx({ account: account2, ticket: recoveryTicket(paper), newRoot: thiefRoot, nullifier: theft.nullifier, proof: theft.proof }));
const theftId = (await read<bigint>(account2, "nextItem")) - 1n;
await mined("owner vetoes it", master(owner, account2, epochSalt, [ops.veto(theftId)]));
await reverts("Installing a vetoed root", "RecoveryVetoed", { address: account2, functionName: "executeQueued", args: [theftId], account: privateKeyToAccount(deployer).address });
const again = await proveRecovery({ secret: paper, newRoot: keccak256(toHex("second try")), account: account2, epochSalt, chainId: DEVNET.chainId });
// A new root is a new nonce key, so this reaches the contract on nonce 0, and the nullifier is what stops it.
await refused("The thief tries again with the same paper", recoveryTx({ account: account2, ticket: recoveryTicket(paper), newRoot: keccak256(toHex("second try")), nullifier: again.nullifier, proof: again.proof }), "NullifierSpent");

const queueGas = evidence.find((e) => e.step === "queue recovery")?.verifyGas ?? null;
mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../docs/evidence/recovery-latest.json", import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch",
      chainId: DEVNET.chainId,
      genesis: deployments().genesis,
      verifier: v2.recoveryVerifier,
      implementation: v2.implementation,
      account,
      proverMs: proved.ms,
      verifyGas: queueGas,
      failures: tally.failures,
      mined: evidence,
      refusals,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\n${evidence.length} mined, ${refusals.length} refused, ${tally.failures} failures, ${Math.round((Date.now() - started) / 1000)}s`);
await stopProver();
process.exit(tally.failures ? 1 : 0);
