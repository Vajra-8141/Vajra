/**
 * The second route, as a user runs it. `exit-setup` needs the master key, once. `exit` needs only the exit tree, and it is the way
 * out when the account itself is held up: see docs/FINDINGS.md section 12.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Address, formatEther, parseEther } from "viem";
import { MasterSigner, WOTS_W16, accountState, createExit, deployments, framesSucceeded, ops, opsV2, publicClient, signExitTx, submit } from "@vajra/core";
import { fileStore, loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { V2_STAKE, requireWallet, runCalls } from "./wallet.ts";

const exitPath = keyPath("exit.json");
const exitTree = () => new MasterSigner(WOTS_W16, fileStore(keyPath("signer.exit.json")), () => new Uint8Array(randomBytes(32)));

/** A tree of its own, a contract of its own, and money of its own. The stake is what lets it carry a recovery. */
export async function exitSetup(o: { reserve: string }) {
  if (existsSync(exitPath)) throw new Error(`${exitPath} already exists`);
  const { v2 } = deployments();
  if (!v2?.exitFactory) throw new Error("this deployment has no exit factory: run `vajra deploy v2` first");
  const { account } = requireWallet();
  const { epochSalt } = await accountState(account);
  const tree = exitTree();
  const funder = loadOrCreateKey(keyPath("deployer.key"));
  const exit = await createExit(funder, v2.exitFactory, account, tree.root, epochSalt, parseEther(o.reserve), V2_STAKE);
  const result = await runCalls([opsV2.setExit(exit)], "setExit", console.log);
  writeFileSync(exitPath, JSON.stringify({ exit }, null, 1), { mode: 0o600 });
  console.log(`mined ${result.hash}\nexit ${exit}, ${o.reserve} ETH reserve\nThe exit tree's seed is in ${keyPath("signer.exit.json")}. Back it up apart from the master key: that is what makes it a second way out.`);
}

/** Escapes from the exit's own address, with its own money. A thief's pending transaction, a ban on the account, and an empty account do not reach it. */
export async function exitEscape() {
  const { account, harbor, harborSalt } = requireWallet();
  const { exit } = JSON.parse(readFileSync(exitPath, "utf8")) as { exit: Address };
  const { epochSalt } = await accountState(account);
  const { tx, leaf } = signExitTx({ signer: exitTree(), exit, account, epochSalt, calls: [ops.escape(harbor, harborSalt)] });
  const { hash, receipt } = await submit(tx, { log: console.log });
  if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed`);
  console.log(`mined ${hash}, block ${Number(BigInt(receipt.blockNumber))}, leaf ${leaf}\nharbor ${harbor} holds ${formatEther(await publicClient.getBalance({ address: harbor }))} ETH`);
}
