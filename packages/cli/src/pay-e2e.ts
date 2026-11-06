/**
 * "Pay, it's me", on the local mirror, including the race that would pay twice. Exits non-zero if anything differs from the claim.
 */
import { keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ETH,
  LEGACY_GAS_PRICE,
  accountAbi,
  accountState,
  createAccount,
  deployments,
  framesSucceeded,
  harborCommitment,
  isLocalStack,
  ops,
  publicClient,
  queuedEvents,
  releaseCalls,
  signDaily,
  sleep,
  submit,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { V2_STAKE } from "./wallet.ts";
import { check, master, newSigner, refused, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("run this on the mirror, with VAJRA_STACK=local");

const deployer = loadOrCreateKey(keyPath("deployer.key"));
const dailyKey = generatePrivateKey();
const daily = privateKeyToAccount(dailyKey).address;
const signer = newSigner();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const { v2, genesis } = deployments();
const DELAY = 8n;

const account = await createAccount(
  deployer,
  v2!.factory,
  {
    dailyKey: daily,
    wotsRoot: signer.root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(fresh(), keccak256(toHex("h"))),
    queueDelay: DELAY,
    coolingPeriod: 0n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("0.01")],
    coolingAllowances: [parseEther("0.01")],
    stake: V2_STAKE,
    unstakeDelay: 86_400,
  },
  parseEther("2"),
);
const { epochSalt } = await accountState(account);
const balance = (who: `0x${string}`) => publicClient.getBalance({ address: who });
const item = (id: bigint) => publicClient.readContract({ address: account, abi: accountAbi, functionName: "queuedItem", args: [id] }) as Promise<{ state: number; executeAfter: bigint }>;

async function queue(to: `0x${string}`, amount: bigint) {
  const tx = await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [ops.spend(ETH, to, amount)] });
  const { receipt } = await submit(tx);
  const [event] = queuedEvents(receipt.frameReceipts[1]!.logs as never);
  if (!event) throw new Error("the spend was not queued");
  return event.id;
}

console.log("\n1. Pay, it's me: the money leaves now, and the queue item cannot pay again");
const payee = fresh();
const amount = parseEther("0.5");
const id = await queue(payee, amount);
check((await balance(payee)) === 0n, "nothing has left yet");
const paid = await submit(master(signer, account, epochSalt, releaseCalls({ id, recipient: payee, asset: ETH, amount })));
check(framesSucceeded(paid.receipt), `released with the hash key, VERIFY ${Number(BigInt(paid.receipt.frameReceipts[0]!.gasUsed))} gas`);
check((await balance(payee)) === amount, "the payee got exactly the amount, before the timer");
check((await item(id)).state === 3, "the queue item is cancelled");
await sleep(Number(DELAY) * 1000 + 4000);
const again = await publicClient
  .simulateContract({ address: account, abi: accountAbi as never, functionName: "executeQueued", args: [id], account: privateKeyToAccount(deployer) } as never)
  .then(() => "allowed", (e: Error) => e.message);
check(again !== "allowed", "after the timer it still cannot pay a second time");

console.log("\n2. The race: someone executes the item first, then the release lands");
const payee2 = fresh();
const id2 = await queue(payee2, amount);
for (;;) {
  if ((await publicClient.getBlock()).timestamp > (await item(id2)).executeAfter) break;
  await sleep(1000);
}
await waitForSuccess(
  await walletFor(deployer).writeContract({ address: account, abi: accountAbi as never, functionName: "executeQueued", args: [id2], gas: 3_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never),
  "executing the matured item",
);
check((await balance(payee2)) === amount, "the matured item paid once");
const late = await submit(master(signer, account, epochSalt, releaseCalls({ id: id2, recipient: payee2, asset: ETH, amount })));
check(late.receipt.frameReceipts[1]!.status !== "0x1" && late.receipt.frameReceipts[2]!.status !== "0x1", "both frames of the late release undid");
check((await balance(payee2)) === amount, "the payee did not get paid twice");

console.log("\n3. The daily key cannot release anything");
const id3 = await queue(fresh(), amount);
const calls = releaseCalls({ id: id3, recipient: fresh(), asset: ETH, amount }).map((c) => ({ ...c, execution: 100_000n, state: 100_000n }));
await refused("Daily key releases a queued payment", await signDaily({ key: dailyKey, dailyKey: daily, account, calls }), "EscapeKeyOutranks");
await refused("Daily key pays straight out in a frame", await signDaily({ key: dailyKey, dailyKey: daily, account, calls: calls.slice(1) }), "FrameNotAllowed");

console.log(`\n${tally.failures} failures`);
process.exit(tally.failures ? 1 : 0);
