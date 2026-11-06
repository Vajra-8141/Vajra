/**
 * The shielded pool, end to end, on the local mirror: notes in, notes out, and the rulebook holding inside the pool. Every
 * attack is attempted against the real client and the patched sidecar. Exits non-zero if anything differs from the claim.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { type Address, type Hex, formatEther, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as lib from "@forshtat/hegota-support/tx";
import {
  DEVNET,
  ETH,
  type FlatProof,
  LEGACY_GAS_PRICE,
  SHIELD_EXECUTION_GAS,
  accountState,
  accountV2Abi,
  deployments,
  isLocalStack,
  ops,
  opsV2,
  profile,
  publicClient,
  signDaily,
  simulate,
  proofWork,
  unshieldNonceKey,
  unshieldTx,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { type Note, newNote, noteCommitment, proveUnshield, stopProver } from "./proving.ts";
import { denomination, noteFee, poolLeaves, readPool } from "./shield.ts";
import { check, evidence, master, mined, newAccount, newSigner, refusals, refused, reverts, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this run makes 30 deposits, which the public faucet cannot pay for: run it with VAJRA_STACK=local, after `vajra judge`");

const started = Date.now();
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const outsider = privateKeyToAccount(deployer).address;
const { v2 } = deployments();
if (!v2) throw new Error("no V2 deployment on this stack: run `vajra deploy` first");
const DENOM = denomination();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

const harbor = fresh();
const harborSalt = keccak256(toHex("harbor"));
const dailyKey = generatePrivateKey();
const daily = privateKeyToAccount(dailyKey).address;
const signer = newSigner();
const account = await newAccount(deployer, signer, daily, harbor, harborSalt, parseEther("2"));
const { epochSalt } = await accountState(account);
const chainId = DEVNET.chainId;
const key = (note: Note, leaf: number, recipient: Address, leaves: bigint[]) =>
  proveUnshield({ note, leaves, leaf, recipient, denomination: DENOM, account, chainId });

/** Outsiders paying in, as fast as a block will take them. Ordinary transactions: anyone may deposit. */
async function outsiderDeposits(count: number) {
  const wallet = walletFor(deployer);
  let nonce = await publicClient.getTransactionCount({ address: outsider });
  const hashes: Hex[] = [];
  for (let i = 0; i < count; i++) {
    const commitment = await noteCommitment(newNote());
    hashes.push(
      await wallet.writeContract({
        address: account,
        abi: accountV2Abi as never,
        functionName: "shield",
        args: [commitment],
        value: DENOM,
        gas: 8_000_000n,
        gasPrice: LEGACY_GAS_PRICE,
        type: "legacy",
        nonce: nonce++,
        chain: undefined,
      } as never),
    );
  }
  for (const hash of hashes) await waitForSuccess(hash, "an outsider's deposit");
}

console.log(`\n1. Notes in. Account ${account}, ${formatEther(DENOM)} ETH a note`);
await reverts("An outsider opens the pool on someone else's account", "PoolClosed", { address: account, functionName: "shield", args: [123n], value: DENOM, account: outsider });
const a = newNote();
const shieldA = await mined("shield note A, master key", master(signer, account, epochSalt, [opsV2.shield(await noteCommitment(a), DENOM)]));
check((await readPool<bigint>(account, "poolHeld")) === DENOM, "the pool holds one note");
console.log(`    SENDER frame ${Number(BigInt(shieldA.receipt.frameReceipts[1]!.gasUsed))} gas`);
await outsiderDeposits(1);
const b = newNote();
await mined("shield note B, master key", master(signer, account, epochSalt, [opsV2.shield(await noteCommitment(b), DENOM)]));
await reverts("A deposit of the wrong size", "ValueNotConserved", { address: account, functionName: "shield", args: [123n], value: DENOM + 1n, account: outsider });
await reverts("A commitment outside the field", "CommitmentInvalid", { address: account, functionName: "shield", args: [(1n << 256n) - 1n], value: DENOM, account: outsider });

console.log("\n2. The daily key tries the pool");
const recipient = fresh();
const daySigned = (calls: Parameters<typeof signDaily>[0]["calls"]) => signDaily({ key: dailyKey, dailyKey: daily, account, calls });
// Limits small enough to pass the daily fee cap, so that these reach the check they are aimed at.
const light = { execution: 300_000n, state: 200_000n };
await refused("Daily key shields the balance into a note it controls", await daySigned([{ ...opsV2.shield(1n, DENOM), ...light }]), "FrameNotAllowed");
await refused("Daily key shields with no value in the frame", await daySigned([{ ...opsV2.shield(1n, 0n), ...light }]), "EscapeKeyOutranks");
await refused("Daily key unshields with no proof", await daySigned([opsV2.unshield(1n, 2n, recipient)]), "EscapeKeyOutranks");

console.log("\n3. Attacks on the proof");
let leaves = await poolLeaves(account);
const proofA = await key(a, 0, recipient, leaves);
const tx = (over: Partial<Parameters<typeof unshieldTx>[0]> = {}) =>
  unshieldTx({ account, root: proofA.root, nullifierHash: proofA.nullifierHash, recipient, proof: proofA.proof, ...over });

const bent = [...proofA.proof] as unknown as bigint[];
bent[2] = bent[2]! + 1n;
await refused("A real proof, with no work done", tx({ work: proofWork(account, proofA.proof, unshieldNonceKey(proofA.nullifierHash, recipient)) + 1n }), "ProofWorkMissing");
await refused("A corrupted proof", tx({ proof: bent as unknown as FlatProof }), "ShieldProofInvalid");
await refused("A seen proof, moved to the attacker's address", tx({ recipient: fresh() }), "ShieldProofInvalid");
const other = await proveUnshield({ note: a, leaves, leaf: 0, recipient, denomination: DENOM, account: fresh(), chainId });
await refused("A proof made for another account", tx({ proof: other.proof }), "ShieldProofInvalid");
const bigger = await proveUnshield({ note: a, leaves, leaf: 0, recipient, denomination: DENOM * 2n, account, chainId });
await refused("A proof claiming a larger denomination", tx({ proof: bigger.proof }), "ShieldProofInvalid");
const forged = newNote();
const forgedProof = await proveUnshield({ note: forged, leaves: [await noteCommitment(forged)], leaf: 0, recipient, denomination: DENOM, account, chainId });
await refused("A note in a tree of the attacker's own", unshieldTx({ account, root: forgedProof.root, nullifierHash: forgedProof.nullifierHash, recipient, proof: forgedProof.proof }), "RootUnknown");
const honest = tx();
const extra = lib.frame(profile, "SENDER", { target: fresh(), execution: 400_000n, state: 400_000n, value: parseEther("0.5"), data: "0x" });
await refused("A seen proof, with a frame added that pays the attacker", { ...honest, frames: [...honest.frames, extra] }, "ProofTxShapeInvalid");
await refused("A seen proof, resent with a huge fee", tx({ fees: { maxFeePerGas: 100_000_000_000n } }), "ProofTxCostExceeded");
const starve = (limits: { execution?: bigint; state?: bigint }) => ({ ...honest, frames: honest.frames.map((f, i) => (i === 1 ? { ...f, limits: { ...f.limits, ...limits } } : f)) });
await refused("A seen proof, resent with too little execution gas, to kill the note", starve({ execution: 1000n }), "ProofTxShapeInvalid");
await refused("A seen proof, resent with too little state gas, to kill the note", starve({ state: 0n }), "ProofTxShapeInvalid");
await refused("A seen proof, on a nonce key of the attacker's choosing", { ...honest, nonceKeys: [12345n] }, "ProofTxShapeInvalid");

console.log("\n4. A note out, with no key anywhere");
const before = await publicClient.getBalance({ address: recipient });
const out = await mined("unshield note A", honest);
check((await publicClient.getBalance({ address: recipient })) - before === DENOM - noteFee(), `the recipient got exactly the note less its fee, ${formatEther(DENOM - noteFee())} ETH`);
check((await readPool<bigint>(account, "poolHeld")) === DENOM * 2n, "the pool's accounting fell by one note");
console.log(`    VERIFY ${Number(BigInt(out.receipt.frameReceipts[0]!.gasUsed))} gas`);
await refused("The same note again, on the next nonce", { ...honest, nonceSeq: 1n }, "NullifierSpent");

console.log("\n5. The tree moves under a proof");
leaves = await poolLeaves(account);
const proofB = await key(b, 2, recipient, leaves);
await outsiderDeposits(30);
check(await readPool<boolean>(account, "isKnownRoot", [proofB.root]), "30 deposits later the proof's root is still in the window");
await mined("unshield note B, proved 30 deposits ago", unshieldTx({ account, root: proofB.root, nullifierHash: proofB.nullifierHash, recipient, proof: proofB.proof }));

const c = newNote();
await mined("shield note C, master key", master(signer, account, epochSalt, [opsV2.shield(await noteCommitment(c), DENOM)]));
leaves = await poolLeaves(account);
const leafC = leaves.length - 1;
const stale = await key(c, leafC, recipient, leaves);
await outsiderDeposits(32);
const staleTx = unshieldTx({ account, root: stale.root, nullifierHash: stale.nullifierHash, recipient, proof: stale.proof });
await refused("A proof whose root has left the window", staleTx, "RootUnknown");
console.log("    that is a tier, not an error: the note is fine, so prove against a newer root");
leaves = await poolLeaves(account);
const renewed = await key(c, leafC, recipient, leaves);
check(renewed.root === (await readPool<bigint>(account, "poolRoot")), "the client's tree matches the contract's root");
await mined("unshield note C, proved again", unshieldTx({ account, root: renewed.root, nullifierHash: renewed.nullifierHash, recipient, proof: renewed.proof }));

console.log("\n6. The rulebook holds inside the pool");
// A second account, small enough that a spend inside the daily limit can reach past the free balance into the notes.
const smallSigner = newSigner();
const small = await newAccount(deployer, smallSigner, daily, harbor, keccak256(toHex("small")), parseEther("0.3"));
await mined("shield a note on the small account", master(smallSigner, small, epochSalt, [opsV2.shield(await noteCommitment(newNote()), DENOM)]));
const smallHeld = await readPool<bigint>(small, "poolHeld");
const smallFree = (await publicClient.getBalance({ address: small })) - smallHeld;
const spendTo = (amount: bigint) => signDaily({ key: dailyKey, dailyKey: daily, account: small, calls: [ops.spend(ETH, fresh(), amount)] });
const raid = await simulate(await spendTo(smallFree + 1n));
check(raid.frames?.[1]?.succeeded === false, `Daily spend reaching one wei into the notes, inside the limit: its frame fails (${raid.executionError ?? "no error text"})`);
refusals.push({ attack: "Daily spend reaching one wei into the notes", refusal: "ValueNotConserved, in the SENDER frame" });
// The fee is paid first, so what is free by then is less. The point is the other side of the line: free money still moves.
const fine = await simulate(await spendTo(smallFree / 2n));
check(fine.frames?.[1]?.succeeded === true, "A daily spend of free money still works");

const d = newNote();
await mined("shield note D, master key", master(signer, account, epochSalt, [opsV2.shield(await noteCommitment(d), DENOM)]));
leaves = await poolLeaves(account);
const leafD = leaves.length - 1;
const proofD = await key(d, leafD, recipient, leaves);
const txD = unshieldTx({ account, root: proofD.root, nullifierHash: proofD.nullifierHash, recipient, proof: proofD.proof });
await mined("freeze, master key", master(signer, account, epochSalt, [ops.freeze()]));
await refused("A valid proof, while frozen", txD, "AccountFrozen");
await reverts("A deposit, while frozen", "AccountFrozen", { address: account, functionName: "shield", args: [123n], value: DENOM, account: outsider });
await mined("unfreeze, master key", master(signer, account, epochSalt, [ops.unfreeze()]));

console.log("\n7. Escape drains the pool to the sealed harbor");
const held = await readPool<bigint>(account, "poolHeld");
const total = await publicClient.getBalance({ address: account });
await mined("escape, master key", master(signer, account, epochSalt, [ops.escape(harbor, harborSalt)]));
const landed = await publicClient.getBalance({ address: harbor });
check(landed >= held, `the harbor holds ${formatEther(landed)} ETH, covering the ${formatEther(held)} ETH of notes`);
check(landed > total - parseEther("0.01"), "everything but the fee arrived");
check((await readPool<bigint>(account, "poolHeld")) === 0n && (await readPool<boolean>(account, "poolClosed")), "the pool is empty and closed");
await refused("A valid proof, after the escape", txD, "AccountFrozen");
// New money arrives after the escape. An old note must not be able to claim it.
await waitForSuccess(await walletFor(deployer).sendTransaction({ to: account, value: parseEther("0.2"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "funding after the escape");
await mined("unfreeze after the escape, master key", master(signer, account, epochSalt, [ops.unfreeze()]));
await refused("An old note, against money that arrived after the escape", txD, "ValueNotConserved");
await reverts("A deposit into a closed pool", "PoolClosed", { address: account, functionName: "shield", args: [123n], value: DENOM, account: outsider });

mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../docs/evidence/shielded-latest.json", import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch",
      chainId,
      genesis: deployments().genesis,
      verifier: v2.shieldVerifier,
      implementation: v2.implementation,
      account,
      denomination: DENOM.toString(),
      proverMs: proofA.ms,
      unshieldVerifyGas: evidence.find((e) => e.step === "unshield note A")?.verifyGas ?? null,
      shieldSenderGas: Number(BigInt(shieldA.receipt.frameReceipts[1]!.gasUsed)),
      shieldExecutionLimit: Number(SHIELD_EXECUTION_GAS),
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
