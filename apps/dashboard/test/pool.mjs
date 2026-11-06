// The pool's meter on the account page, in a real browser against the mirror. The deposits are real transactions from the real CLI, and
// the failed read is the browser's own requests to the chain being cut off. Run with the mirror and the dashboard up: `make judge`, `make dashboard`.
//   CHROMIUM=/usr/bin/chromium node apps/dashboard/test/pool.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";
const LANE = Number(process.env.VAJRA_LANE ?? 0);
const RPC = `http://127.0.0.1:${18545 + LANE * 100}`;
const CLI = new URL("../../../packages/cli/src/main.ts", import.meta.url).pathname;
const STATE = new URL("../../../.vajra-local/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const vajra = (args, state) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, VAJRA_STACK: "local", ...(state ? { VAJRA_STATE_DIR: state } : {}) }, encoding: "utf8" });
const { account } = JSON.parse(readFileSync(join(STATE, "wallet.json"), "utf8"));
const deployerKey = readFileSync(join(STATE, "deployer.key"), "utf8").trim();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
const until = async (test, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(300)) if (await test().catch(() => false)) return true;
  return false;
};
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const card = page.locator('section[aria-labelledby="pool"]');
const text = () => card.innerText();

console.log("\nAn account with no notes");
await page.goto(`${BASE}/account`);
await page.getByRole("heading", { name: "Balance" }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(6000);
const before = await card.count();
check(before === 0, "an account with nothing in a pool shows no pool card, so the theft story stays as it was");

console.log("\nThe owner alone");
vajra(["shield"]);
check(await until(async () => (await text()).includes("Hides nothing.")), "after a real deposit the card says it hides nothing");
const alone = await text();
check(alone.includes("plainly yours") && alone.includes("1 note paid in"), "and says why, with the count beside the sentence");
check(alone.includes("No chain can show") && alone.includes("different people") && alone.includes("not that"), "the limits are on the card, at normal size");
await shot("pool-alone");

console.log("\nAn outsider pays in");
const friend = mkdtempSync(join(tmpdir(), "vajra-pool-page-"));
const keyFile = join(friend, "key.txt");
writeFileSync(keyFile, deployerKey, { mode: 0o600 });
vajra(["shield", "--account", account, "--key-file", keyFile], friend);
vajra(["shield", "--account", account, "--key-file", keyFile], friend);
check(await until(async () => (await text()).includes("at most 2 addresses")), "the card moves to at most 2 addresses");
const two = await text();
check(!/hides you|anonymous|untraceable/i.test(two), "nothing says the pool hides you well");
check(two.includes("right about 2 times in 3"), "it gives the odds of a guess at the largest depositor");
check((await page.locator(".pool-shares span").count()) === 2 && (await page.locator(".pool-shares span.own").count()) === 1, "the bar has one block for each address, and marks this account's");
await shot("pool-two");

console.log("\nA payment fails");
// One byte of INVALID: a contract that takes nothing, so this is a real refused payment.
const wallet = createWalletClient({ account: privateKeyToAccount(deployerKey), transport: http(RPC), chain: { id: 13370, name: "mirror", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } });
const placed = await wallet.sendTransaction({ data: "0x60fe60005360016000f3", gas: 1_000_000n, gasPrice: 2_000_000n, type: "legacy" });
let refuser = null;
for (let i = 0; i < 30 && !refuser; i++) {
  const reply = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [placed] }) });
  refuser = (await reply.json()).result?.contractAddress ?? null;
  if (!refuser) await page.waitForTimeout(1000);
}
const said = vajra(["unshield", refuser, "--no-check"]);
check(said.includes("refused the money"), "the holder is told the recipient refused");
check(await until(async () => (await text()).includes("1 payment failed")), "the card says the money is still held");
check((await text()).includes("1 spent"), "and counts the note as spent");
await shot("pool-owed");

console.log("\nA phone");
await page.setViewportSize({ width: 360, height: 780 });
await page.waitForTimeout(400);
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll at 360px");
await card.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/pool-phone.png` });
await page.setViewportSize({ width: 1280, height: 900 });

console.log("\nThe chain stops answering");
await page.route(`${RPC}/**`, (route) => route.abort());
await page.route(RPC, (route) => route.abort());
check(await until(async () => (await text()).includes("latest read failed")), "a failed read keeps the last answer, and says so");
const stale = await text();
check(stale.includes("at most 2 addresses"), "the old figure is not replaced by a zero");
await page.reload();
await page.getByRole("heading", { name: "Balance" }).waitFor({ timeout: 60_000 }).catch(() => {});
const fresh = await until(async () => (await card.count()) > 0 && (await text()).includes("Unknown"), 90_000);
check(fresh, "a page with no earlier answer says unknown, and does not read as an empty pool");
if (fresh) check(!/\b0 notes?\b|Nothing has been paid in/.test(await text()), "and shows no zero");
await shot("pool-unknown");
await page.unroute(`${RPC}/**`);
await page.unroute(RPC);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
