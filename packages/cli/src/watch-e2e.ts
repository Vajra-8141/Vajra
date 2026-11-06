/**
 * The whole phone path on the mirror, with a local stand-in for Telegram's servers: the real watcher, the real chain, real
 * transactions. This does NOT test Telegram itself or a phone. Those need a real bot.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ETH, accountAbi, isLocalStack, ops, publicClient, signDaily, sleep, submit } from "@vajra/core";
import { localDailyAddress, localDailyKey, requireWallet } from "./wallet.ts";
import { check, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("run this on the mirror, with VAJRA_STACK=local");

const OWNER = 42;
const sent: { text: string; buttons: string[] }[] = [];
const answers: string[] = [];
let queued: unknown[] = [];
let nextUpdate = 1;

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const method = req.url!.split("/").pop();
    const reply = (result: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === "sendMessage") {
      sent.push({ text: body.text, buttons: (body.reply_markup?.inline_keyboard?.[0] ?? []).map((b: { callback_data: string }) => b.callback_data) });
      return reply({});
    }
    if (method === "answerCallbackQuery") {
      answers.push(body.text);
      return reply(true);
    }
    const updates = queued;
    queued = [];
    reply(updates);
  });
});
await new Promise<void>((resolve) => server.listen(18081, "127.0.0.1", resolve));

const tap = (from: number, data: string) => queued.push({ update_id: nextUpdate++, callback_query: { id: "q", from: { id: from }, data } });

function startWatcher(extra: string[] = []) {
  const child = spawn(process.execPath, [new URL("./main.ts", import.meta.url).pathname, "watch", ...extra], {
    env: { ...process.env, TELEGRAM_API: "http://127.0.0.1:18081", TELEGRAM_BOT_TOKEN: "test", TELEGRAM_CHAT_ID: String(OWNER) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.WATCH_LOG && process.stdout.write(d));
  return child;
}

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 45_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(500);
  }
  check(false, `timed out: ${what}`);
  return false;
}

const { account } = requireWallet();
const state = async (id: bigint) => ((await publicClient.readContract({ address: account, abi: accountAbi, functionName: "queuedItem", args: [id] })) as { state: number }).state;
const steal = async (to: `0x${string}`) => {
  const next = (await publicClient.readContract({ address: account, abi: accountAbi, functionName: "nextItem" })) as bigint;
  await submit(await signDaily({ key: localDailyKey(), dailyKey: localDailyAddress(), account, calls: [ops.spend(ETH, to, parseEther("0.5"))] }));
  return next;
};
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

console.log("\n1. A theft reaches the phone, and only the owner can answer");
let watcher = startWatcher();
await sleep(3000);
const id = await steal(fresh());
await until("the alert", () => sent.some((m) => m.buttons.includes(`veto:${id}`)));
const alert = sent.find((m) => m.buttons.includes(`veto:${id}`))!;
check(alert.text.includes("0.5 ETH"), `the alert: ${alert.text.slice(0, 90)}`);
check(alert.buttons.includes(`pay:${id}`), "it offers both buttons");
tap(7, `veto:${id}`);
await until("the stranger's refusal", () => answers.includes("This account is not the owner."));
check((await state(id)) === 1, "a stranger's tap did nothing");

console.log("\n2. Pay is off on a software signer");
tap(OWNER, `pay:${id}`);
await until("the refusal", () => answers.some((a) => a.includes("hardware signer")));
check((await state(id)) === 1, "the item is still waiting");

console.log("\n3. Not me: the hash key cancels it");
tap(OWNER, `veto:${id}`);
await until("the cancel", async () => (await state(id)) === 3, 60_000);
check((await state(id)) === 3, "the item is cancelled on chain");
await until("the confirmation", () => sent.some((m) => m.text.startsWith(`Cancelled item ${id}`)));
tap(OWNER, `veto:${id}`);
await until("the second tap's refusal", () => answers.some((a) => a.includes("no longer waiting")));
check(true, "a second tap on the same button does nothing");
watcher.kill();

console.log("\n4. Pay, it's me: with the flag on, the money leaves at once");
watcher = startWatcher(["--allow-software-pay"]);
await sleep(3000);
const to = fresh();
const id2 = await steal(to);
await until("the alert", () => sent.some((m) => m.buttons.includes(`pay:${id2}`)));
tap(OWNER, `pay:${id2}`);
await until("the payment", async () => (await publicClient.getBalance({ address: to })) === parseEther("0.5"), 60_000);
check((await publicClient.getBalance({ address: to })) === parseEther("0.5"), "the recipient has the money, before the timer");
check((await state(id2)) === 3, "the queue item cannot pay again");
watcher.kill();

console.log(`\n${tally.failures} failures`);
server.close();
process.exit(tally.failures ? 1 : 0);
