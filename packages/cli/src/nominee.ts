/**
 * The nominee. `nominee-setup` signs a rescue, with the exit's key, for the owner to hand over. `nominee-watch` is what the holder runs: it
 * reads that file and the chain, and it holds no key.
 *
 * It is a dead man's switch on the queue, not on a calendar. A theft has to wait in public, and the owner gets asked. If the item is still
 * waiting when the margin is reached, nobody answered, so the rescue goes. See docs/FINDINGS.md section 23.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type Address, encodeFunctionData, formatEther, getAddress, parseGwei } from "viem";
import {
  DEFAULT_FEES,
  ETH,
  MasterSigner,
  WOTS_W16,
  accountState,
  accountV2Abi,
  checkRescue,
  defaultMargin,
  exitAbi,
  framesSucceeded,
  genesisHash,
  parseRescue,
  publicClient,
  rescueDue,
  rescueFile,
  sendRescue,
  signRescue,
  sleep,
} from "@vajra/core";
import { fileStore } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { exitPath, exitTree } from "./exit.ts";
import { requireWallet, runCalls } from "./wallet.ts";

export const localRescuePath = () => keyPath("rescue.json");

/** A rescue cannot raise its fee later, so it is signed well above today's. This is a cap: unused gas comes back. */
const DEFAULT_MAX_FEE_GWEI = "10";

/** How long the owner's own alert says they have. Null if this machine has signed no rescue. */
export function localRescueMargin(): number | null {
  try {
    return parseRescue(readFileSync(localRescuePath(), "utf8")).marginSeconds;
  } catch {
    return null;
  }
}

export async function nomineeSetup(o: { out?: string; margin?: string; maxFee?: string; tokens?: string }) {
  const { account, harbor, harborSalt } = requireWallet();
  if (!existsSync(exitPath)) throw new Error("a rescue runs from the exit, so set that up first: vajra exit-setup --reserve 0.03");
  const { exit } = JSON.parse(readFileSync(exitPath, "utf8")) as { exit: Address };
  const read = <T>(functionName: string) => publicClient.readContract({ address: account, abi: accountV2Abi as never, functionName } as never) as Promise<T>;
  if (getAddress(await read<Address>("exit")) !== getAddress(exit)) throw new Error(`the account does not name ${exit} as its exit`);
  const [{ epochSalt }, assets, delay, genesis] = await Promise.all([accountState(account), read<readonly Address[]>("assets"), read<bigint>("queueDelay"), genesisHash()]);

  const margin = o.margin ? Number(o.margin) : defaultMargin(Number(delay));
  if (!Number.isSafeInteger(margin) || margin <= 0 || margin >= Number(delay)) throw new Error(`the margin has to be between 0 and the queue's delay, ${delay} seconds`);
  const extra = (o.tokens ?? "").split(",").filter(Boolean).map((token) => getAddress(token));
  const tokens = assets.filter((asset) => asset !== ETH).length + extra.length;
  const fees = { maxFeePerGas: parseGwei(o.maxFee ?? DEFAULT_MAX_FEE_GWEI), maxPriorityFeePerGas: DEFAULT_FEES.maxPriorityFeePerGas };

  const { tx, leaf } = signRescue({ signer: exitTree(), exit, account, epochSalt, harbor, harborSalt, tokens, extra, fees });
  const text = rescueFile({ tx, genesis, marginSeconds: margin });
  const out = o.out ?? localRescuePath();
  const replaced = existsSync(out);
  writeFileSync(out, text, { mode: 0o600 });
  if (out !== localRescuePath()) writeFileSync(localRescuePath(), text, { mode: 0o600 });

  const rescue = parseRescue(text);
  const check = await checkRescue(rescue);
  console.log(`signed with leaf ${leaf} of the exit's tree, and written to ${out}`);
  console.log(`it moves everything from ${account} to ${harbor}, and does nothing else`);
  console.log(`it goes out ${margin} seconds before anything waiting would leave, if nobody has answered`);
  console.log(`it can cost up to ${formatEther(rescue.maxCost)} ETH, from the exit's reserve`);
  if (check.state === "ready") console.log(`checked against the node: it would work now. VERIFY ${check.verifyGas} gas, ${check.totalGas} in all`);
  else console.log(`checked against the node: ${check.state}. ${"reason" in check ? check.reason : ""}`);
  console.log(`\nGive that file to your nominee. They run: vajra nominee-watch --rescue <file>\nWhoever holds it can send your money to your harbor, and nowhere else. They learn where your harbor is.\nFrom now on every queued payment needs an answer from you, or the rescue goes.`);
  if (replaced) console.log("\nThe rescue this replaces stays valid. To end every rescue you have signed: vajra nominee-revoke");
}

export async function nomineeCheck(path: string) {
  const rescue = parseRescue(readFileSync(path, "utf8"));
  const check = await checkRescue(rescue);
  console.log(`account ${rescue.account}\nexit ${rescue.exit}\nharbor ${rescue.harbor}\nreserve needed ${formatEther(rescue.maxCost)} ETH`);
  if (check.state === "ready") console.log(`ready: it would work now, reserve ${formatEther(check.reserve)} ETH, VERIFY ${check.verifyGas} gas, ${check.totalGas} in all`);
  else if (check.state === "sent") console.log(`already sent${check.hash ? `: ${check.hash}, block ${check.block}, ${check.succeeded ? "all frames ok" : "A FRAME FAILED"}` : ", or a copy of it was"}`);
  else console.log(`${check.state}: ${check.reason}`);
  process.exitCode = check.state === "ready" ? 0 : 1;
}

/** Holds no key: it reads the file and the chain, and sends the same bytes. Stops when the rescue has landed. */
export async function nomineeWatch(o: { rescue: string; margin?: string; interval?: string }) {
  const rescue = parseRescue(readFileSync(o.rescue, "utf8"));
  const margin = o.margin ? Number(o.margin) : rescue.marginSeconds;
  const interval = Number(o.interval ?? 3) * 1000;
  console.log(`watching ${rescue.account}. This process holds no key.\nIf anything is still waiting ${margin} seconds before it leaves, this sends everything to ${rescue.harbor}.`);

  let said = "";
  const once = (line: string) => {
    if (line !== said) console.log(line);
    said = line;
  };
  const told = new Set<bigint>();
  for (;;) {
    try {
      const health = await checkRescue(rescue);
      if (health.state === "sent") {
        console.log(health.hash ? `already sent: ${health.hash}, block ${health.block}` : "already sent: a copy of it landed");
        return;
      }
      once(health.state === "ready" ? `the rescue is ready, and would work now` : `the rescue is ${health.state}: ${health.reason}`);

      const due = await rescueDue(rescue, margin);
      for (const item of due.waiting) {
        if (told.has(item.id)) continue;
        told.add(item.id);
        console.log(`item ${item.id} leaves in ${Number(item.executeAfter) - due.now} seconds, and nobody has answered. The rescue goes with ${margin} seconds left`);
      }
      if (due.due) {
        // Broken means it is known to fail, and a failed frame would spend the nonce key for nothing. Unknown is worth a try: nothing else can stop this now.
        if (health.state === "broken") {
          console.log(`A PAYMENT IS ABOUT TO LEAVE AND THIS RESCUE WOULD FAIL. ${health.reason}`);
        } else {
          console.log(`nobody answered. Sending the rescue, with ${due.soonest! - due.now} seconds left`);
          const { hash, receipt, route } = await sendRescue(rescue, { log: console.log });
          if (framesSucceeded(receipt)) {
            console.log(`rescued: ${hash}, block ${Number(BigInt(receipt.blockNumber))}, through the ${route} mempool. The harbor holds ${formatEther(await publicClient.getBalance({ address: rescue.harbor }))} ETH`);
            return;
          }
          console.log(`THE RESCUE MINED AND A FRAME FAILED: ${hash}`);
          process.exitCode = 1;
          return;
        }
      }
    } catch (error) {
      // A bad network must not end the watch, and it must not read as a quiet queue.
      console.log(`state unknown, trying again: ${(error as Error).message}`);
    }
    await sleep(interval);
  }
}

/**
 * Every rescue is tied to the exit's key tree, so a new tree ends them all. This takes the master key, and a thief with the daily key
 * cannot reach it. A leaf that has signed cannot safely sign again, so there is no way to end just one.
 */
export async function nomineeRevoke() {
  requireWallet();
  if (!existsSync(exitPath)) throw new Error("no exit here");
  const { exit } = JSON.parse(readFileSync(exitPath, "utf8")) as { exit: Address };
  const nextPath = keyPath("signer.exit.next.json");
  if (existsSync(nextPath)) throw new Error(`${nextPath} is here from a revoke that did not finish. Check which tree the exit holds before going on`);
  const next = new MasterSigner(WOTS_W16, fileStore(nextPath), () => new Uint8Array(randomBytes(32)));
  const { hash } = await runCalls([{ target: exit, data: encodeFunctionData({ abi: exitAbi, functionName: "setRoot", args: [next.root] }), execution: 60_000n, state: 100_000n }], "replace the exit's tree", console.log);
  renameSync(keyPath("signer.exit.json"), keyPath(`signer.exit.before-${Date.now()}.json`));
  renameSync(nextPath, keyPath("signer.exit.json"));
  rmSync(localRescuePath(), { force: true });
  console.log(`mined ${hash}\nEvery rescue signed so far has stopped working. The exit's new tree is in ${keyPath("signer.exit.json")}: back it up. Sign a new rescue with: vajra nominee-setup`);
}
