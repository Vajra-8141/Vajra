/**
 * The gas rows for proofs, measured as docs/GAS.md measures everything else: ethrex_simulateFrameTransaction against real
 * state, with a fresh proof for every sample. The local mirror runs the commits the public devnet runs, and it has the fork's
 * gas rules, but these numbers are from the mirror.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Hex, keccak256, parseEther, toHex } from "viem";
import { DEVNET, LEGACY_GAS_PRICE, accountState, accountV2Abi, deployments, isLocalStack, opsV2, publicClient, recoveryTx, simulate, unshieldTx, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { newNote, noteCommitment, proveRecovery, proveUnshield, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";
import { denomination } from "./shield.ts";
import { master, mined, newAccount, newSigner } from "./zk-run.ts";

if (!isLocalStack) throw new Error("run this with VAJRA_STACK=local");

const SAMPLES = 24;
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const signer = newSigner();
const account = await newAccount(deployer, signer, fresh(), fresh(), keccak256(toHex("measure")), parseEther("3"));
const { epochSalt } = await accountState(account);
const chainId = DEVNET.chainId;
const DENOM = denomination();

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]!, samples: sorted.length };
};
const report = (name: string, s: ReturnType<typeof stats>) => console.log(`${name}: ${s.samples} samples, min ${s.min} median ${s.median} max ${s.max}`);

async function verifyGas(tx: Parameters<typeof simulate>[0], label: string) {
  const result = await simulate(tx);
  const frame = result.frames?.[0];
  if (!frame?.succeeded) throw new Error(`${label}: VERIFY did not succeed: ${result.executionError ?? "no error given"}`);
  return { verify: Number(BigInt(frame.gasUsed)), total: result.gasUsed ? Number(BigInt(result.gasUsed)) : null };
}

const secret = randomFieldElement();
await mined("set recovery", master(signer, account, epochSalt, [opsV2.setRecovery(await recoveryCommitment(secret), 3600n)]));
const recovery: number[] = [];
const recoveryTotal: number[] = [];
const proverRecovery: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const newRoot = keccak256(toHex(`root ${i} ${Date.now()}`)) as Hex;
  const proved = await proveRecovery({ secret, newRoot, account, epochSalt, chainId });
  proverRecovery.push(proved.ms);
  const gas = await verifyGas(recoveryTx({ account, newRoot, nullifier: proved.nullifier, proof: proved.proof }), "recovery");
  recovery.push(gas.verify);
  if (gas.total) recoveryTotal.push(gas.total);
}

// The root check walks the ring, so what an unshield costs depends on where its root sits. Every position gets a sample.
const wallet = walletFor(deployer);
const note = newNote();
const leaves = [await noteCommitment(note)];
const first = await mined("the first note", master(signer, account, epochSalt, [opsV2.shield(leaves[0]!, DENOM)]));
const shieldFirstSender = Number(BigInt(first.receipt.frameReceipts[1]!.gasUsed));
const shieldLater: number[] = [];
for (let i = 1; i < 32; i++) {
  const commitment = await noteCommitment(newNote());
  leaves.push(commitment);
  const hash = await wallet.writeContract({ address: account, abi: accountV2Abi as never, functionName: "shield", args: [commitment], value: DENOM, gas: 8_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never);
  shieldLater.push(Number((await waitForSuccess(hash, "a deposit")).gasUsed));
}
const unshield: number[] = [];
const unshieldTotal: number[] = [];
const proverUnshield: number[] = [];
const recipient = fresh();
for (let size = leaves.length; size >= 1; size--) {
  const proved = await proveUnshield({ note, leaves: leaves.slice(0, size), leaf: 0, recipient, denomination: DENOM, account, chainId });
  proverUnshield.push(proved.ms);
  const gas = await verifyGas(unshieldTx({ account, root: proved.root, nullifierHash: proved.nullifierHash, recipient, proof: proved.proof }), "unshield");
  unshield.push(gas.verify);
  if (gas.total) unshieldTotal.push(gas.total);
}

const result = {
  ranAt: new Date().toISOString(),
  stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch",
  chainId,
  genesis: deployments().genesis,
  method: "ethrex_simulateFrameTransaction, a fresh proof per sample",
  recoveryVerify: stats(recovery),
  recoveryWholeTx: recoveryTotal.length ? stats(recoveryTotal) : null,
  unshieldVerify: stats(unshield),
  unshieldWholeTx: unshieldTotal.length ? stats(unshieldTotal) : null,
  shieldFirstNoteSenderFrame: shieldFirstSender,
  shieldLaterWholeTx: stats(shieldLater),
  proverMs: { recovery: stats(proverRecovery), unshield: stats(proverUnshield) },
};
report("recovery VERIFY", result.recoveryVerify);
report("unshield VERIFY", result.unshieldVerify);
report("shield, later notes, whole tx", result.shieldLaterWholeTx);
console.log(`shield, first note, SENDER frame: ${shieldFirstSender}`);
report("prover ms, recovery", result.proverMs.recovery);
report("prover ms, unshield", result.proverMs.unshield);
mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../../docs/evidence/zk-gas-latest.json", import.meta.url), JSON.stringify(result, null, 1) + "\n");
await stopProver();
process.exit(0);
