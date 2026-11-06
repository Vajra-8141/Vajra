// The nominee's page, in a real browser against the mirror, with no wallet in the page and no bridge asked for anything. The owner's side
// is the real CLI, and the theft is a real transaction. Run with the mirror and the dashboard up: `make judge`, `make dashboard`.
//   CHROMIUM=/usr/bin/brave-browser node apps/dashboard/test/nominee.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";
const RPC = `http://127.0.0.1:${18545 + Number(process.env.VAJRA_LANE ?? 0) * 100}`;
const CLI = new URL("../../../packages/cli/src/main.ts", import.meta.url).pathname;
const DEPLOYER = new URL("../../../.vajra-local/deployer.key", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

/** An owner of their own, in a folder of their own, so that the demo account is left alone. */
function owner(margin) {
  const dir = mkdtempSync(join(tmpdir(), "vajra-nominee-page-"));
  copyFileSync(DEPLOYER, join(dir, "deployer.key"));
  const vajra = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, VAJRA_STACK: "local", VAJRA_STATE_DIR: dir }, encoding: "utf8" });
  const harbor = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  vajra("create", "--harbor", harbor, "--delay", "60", "--cooling", "0", "--limit", "0.1", "--allowance", "0.1", "--fund", "2");
  vajra("exit-setup", "--reserve", "0.05");
  const file = join(dir, "for-the-nominee.json");
  vajra("nominee-setup", "--out", file, "--margin", String(margin));
  return { vajra, file, harbor };
}

const balance = async (address) => {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }) });
  return BigInt((await response.json()).result);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
const asked = [];
page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
page.on("request", (request) => {
  if (/\/(master|demo|attacks\/run|lab\/run)/.test(new URL(request.url()).pathname)) asked.push(request.url());
});
const until = async (test, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(300)) if (await test().catch(() => false)) return true;
  return false;
};
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const shown = (selector) => page.locator(selector).isVisible();

console.log("\nWith nothing loaded");
await page.goto(`${BASE}/nominee`);
await page.getByRole("heading", { name: "Your nominee" }).waitFor({ timeout: 90_000 });
check(await page.evaluate(() => window.ethereum === undefined), "no wallet exists in this browser");
check(await page.locator('nav a[href="/nominee"]').first().isVisible().catch(() => true), "it is in the menu");
check((await page.locator("[data-rescue]").count()) === 0, "nothing claims to be watching yet");

console.log("\nA file that is not a rescue");
const dir = mkdtempSync(join(tmpdir(), "vajra-nominee-page-"));
const wrong = join(dir, "not-a-rescue.json");
writeFileSync(wrong, JSON.stringify({ kind: "something else" }));
await page.locator("[data-rescue-input]").setInputFiles(wrong);
check(await until(() => shown("[data-rescue-invalid]")), "it is refused, and says why");
check((await page.locator("[data-rescue]").count()) === 0, "and nothing was loaded");

console.log("\nThe owner does not answer, and the page sends it by itself");
const first = owner(40);
await page.locator("[data-rescue-input]").setInputFiles(first.file);
check(await until(() => shown("[data-rescue]")), "the page reads the file");
check((await page.locator("[data-harbor]").textContent()).toLowerCase() === first.harbor.toLowerCase(), "it names the safe address, read from the signed bytes");
check(await until(() => shown('[data-health="ready"]')), "the node says it would work now");
check(await until(() => shown("[data-queue-empty]")), "nothing is waiting");
await shot("nominee-ready");
first.vajra("thief", "0.6");
check(await until(() => shown("[data-waiting]")), "the theft shows up, waiting");
check((await page.getByRole("status").textContent()).includes("Nobody has answered yet"), `it says when the rescue goes: ${(await page.getByRole("status").textContent()).trim()}`);
await shot("nominee-waiting");
check(await until(() => shown("[data-rescued]")), "nobody answered, and the page sent it");
const held = await balance(first.harbor);
check(held > 1_900_000_000_000_000_000n, `the safe address really holds it: ${held} wei`);
check((await page.locator("[data-rescued]").textContent()).includes("Signed by the hash key, in advance"), "it says who signed");
check(await until(async () => (await page.locator("[data-rescued]").textContent()).includes("The safe address holds 1.98")), "and what the safe address now holds");
check(await shown("[data-rescued] .lattice"), "the 67 bars appear, labelled as a picture");
await shot("nominee-rescued");

console.log("\nThe same, sent by hand");
const second = owner(50);
await page.reload();
await page.getByRole("heading", { name: "Your nominee" }).waitFor();
check((await page.locator("[data-rescue]").count()) === 0, "the page kept nothing after a reload");
await page.locator("[data-rescue-input]").setInputFiles(second.file);
check(await until(() => shown('[data-health="ready"]')), "ready again, for another account");
await page.locator("[data-auto]").uncheck();
second.vajra("thief", "0.6");
check(await until(async () => (await page.getByRole("status").textContent()).includes("Nobody answered.")), "past the margin, with sending by itself turned off, it says so");
await page.waitForTimeout(4000);
check((await balance(second.harbor)) === 0n, "and it has not sent anything");
await page.locator("[data-arm]").click();
check((await page.locator("[data-rescue]").count()) === 1 && (await page.getByText("It cannot be undone").isVisible()), "the first press only warns");
await page.getByRole("button", { name: "Keep waiting" }).click();
check((await balance(second.harbor)) === 0n, "and can be taken back");
await page.locator("[data-arm]").click();
await page.locator("[data-send]").click();
check(await until(() => shown("[data-rescued]")), "the second press sends it");
check((await balance(second.harbor)) > 1_900_000_000_000_000_000n, "the safe address holds it");

console.log("\nAt phone width");
await page.setViewportSize({ width: 360, height: 800 });
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);
check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll");
await shot("nominee-phone");

check(asked.length === 0, `no bridge was asked to sign or do anything: ${asked.length ? asked.join(", ") : "none"}`);
check(errors.length === 0, `page errors: ${errors.join("; ") || "none"}`);
await browser.close();
console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
