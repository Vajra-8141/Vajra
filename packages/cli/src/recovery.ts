/**
 * Recovery as a user runs it: three commands, on the real wallet files.
 *
 * `recover-setup` needs the master key. The other two need only the secret, because they are for the day the master key is
 * gone. Nothing here sends the secret anywhere: it goes into the prover on this machine, and only the proof leaves.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { type Address, type Hex, numberToHex } from "viem";
import {
  DEVNET,
  type FlatProof,
  LEGACY_GAS_PRICE,
  MasterSigner,
  WOTS_W16,
  accountState,
  accountV2Abi,
  framesSucceeded,
  opsV2,
  publicClient,
  recoveryTx,
  sleep,
  submit,
  waitForSuccess,
  walletFor,
  recoveryGate,
  recoveryTicket,
} from "@vajra/core";
import { fileStore, loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { FIELD, proveRecovery, randomFieldElement, recoveryCommitment } from "./proving.ts";
import { masterSigner, requireWallet, runCalls } from "./wallet.ts";

const nextTreePath = keyPath("signer.recovered.json");
const proofPath = keyPath("recovery.proof.json");

const read = <T>(address: Address, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address, abi: accountV2Abi as never, functionName, args } as never) as Promise<T>;

/** Creates a secret, and commits to it with the master key. The secret is written once, and is yours to move offline. */
export async function recoverSetup(o: { delay: bigint; out?: string }) {
  const file = o.out ?? keyPath("recovery.secret");
  if (existsSync(file)) throw new Error(`${file} already exists, and overwriting it could lose the only copy`);
  const secret = randomFieldElement();
  writeFileSync(file, numberToHex(secret, { size: 32 }) + "\n", { mode: 0o600 });
  const commitment = await recoveryCommitment(secret);
  const result = await runCalls([opsV2.setRecovery(commitment, o.delay, recoveryGate(recoveryTicket(secret)))], "setRecovery", console.log);
  console.log(`mined ${result.hash}\ncommitment ${numberToHex(commitment, { size: 32 })}\nveto window ${o.delay}s`);
  console.log(`\nThe secret is in ${file}.\nCopy it to paper or steel and delete the file: on this machine it is one more thing to steal.`);
}

/** Needs the secret and nothing else. Makes a new key tree, and proves the account should move to it. */
export async function recoverProve(o: { secretFile?: string; out?: string; account?: Address }) {
  if (!o.secretFile) throw new Error("--secret <file> is required");
  const secret = BigInt(readFileSync(o.secretFile, "utf8").trim());
  if (secret <= 0n || secret >= FIELD) throw new Error("that is not a recovery secret");
  const account = o.account ?? requireWallet().account;
  const { epochSalt } = await accountState(account);
  const next = new MasterSigner(WOTS_W16, fileStore(nextTreePath), () => new Uint8Array(randomBytes(32)));
  const proved = await proveRecovery({ secret, newRoot: next.root, account, epochSalt, chainId: DEVNET.chainId });
  const file = o.out ?? proofPath;
  writeFileSync(
    file,
    JSON.stringify({ account, newRoot: next.root, nullifier: proved.nullifier.toString(), proof: proved.proof.map(String), ticket: recoveryTicket(secret) }, null, 1) + "\n",
  );
  console.log(`proved in ${proved.ms} ms\nnew root ${next.root}\nproof in ${file}. It cannot spend anything, but it does hold the ticket, so keep it private until it is used\nnext: vajra recover --proof ${file}`);
}

/**
 * Sends the proof, waits out the veto window, and installs the root. Run it again after any interruption: a spent nullifier
 * means the proof already landed, so it picks up from the queue.
 */
export async function recover(o: { proofFile: string }) {
  const saved = JSON.parse(readFileSync(o.proofFile, "utf8")) as { account: Address; newRoot: Hex; nullifier: string; proof: string[]; ticket: Hex };
  const account = saved.account;
  const nullifier = BigInt(saved.nullifier);
  const proof = saved.proof.map(BigInt) as unknown as FlatProof;

  if (!(await read<boolean>(account, "recoverySpent", [nullifier]))) {
    const { hash, receipt } = await submit(recoveryTx({ account, newRoot: saved.newRoot, nullifier, proof, ticket: saved.ticket }), { log: console.log });
    if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed`);
    console.log(`mined ${hash}, VERIFY ${Number(BigInt(receipt.frameReceipts[0]!.gasUsed))} gas`);
  }

  const next = await read<bigint>(account, "nextItem");
  let id: bigint | null = null;
  for (let i = next - 1n; i >= 0n && id === null; i--) {
    const item = await read<{ amount: bigint }>(account, "queuedItem", [i]);
    if ((await read<boolean>(account, "isRecovery", [i])) && item.amount === BigInt(saved.newRoot)) id = i;
  }
  if (id === null) throw new Error("the proof landed but its queue item is not there: chain state unknown");

  const item = await read<{ executeAfter: bigint; state: number }>(account, "queuedItem", [id]);
  if (item.state === 3) throw new Error(`RecoveryVetoed: queue item ${id} was cancelled by the master key`);
  if (item.state === 1) {
    console.log(`queue item ${id}: the master key can veto until ${new Date(Number(item.executeAfter) * 1000).toISOString()}`);
    for (;;) {
      if ((await publicClient.getBlock()).timestamp > item.executeAfter) break;
      await sleep(2000);
    }
    const funder = loadOrCreateKey(keyPath("deployer.key"));
    const hash = await walletFor(funder).writeContract({
      address: account,
      abi: accountV2Abi as never,
      functionName: "executeQueued",
      args: [id],
      gas: 3_000_000n,
      gasPrice: LEGACY_GAS_PRICE,
      type: "legacy",
      chain: undefined,
    } as never);
    await waitForSuccess(hash, "installing the root");
    console.log(`installed by ${hash}`);
  }

  const { wotsRoot } = await accountState(account);
  if (wotsRoot.toLowerCase() !== saved.newRoot.toLowerCase()) throw new Error(`the account's root is ${wotsRoot}, not the recovered one: chain state unknown`);
  const tree = keyPath("signer.json");
  if (existsSync(nextTreePath)) {
    if (existsSync(tree)) renameSync(tree, `${tree}.retired-${Date.now()}`);
    renameSync(nextTreePath, tree);
    console.log(`this machine now signs with the new tree: ${masterSigner().root}`);
  }
}
