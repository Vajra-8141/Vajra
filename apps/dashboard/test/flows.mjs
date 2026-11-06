// Drives the dashboard in a real browser against the live devnet. The wallet is a stand-in that makes real signatures
// with the local daily key; everything else, including the route reads take, is the real thing.
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { privateKeyToAccount } from "viem/accounts";

const ROUTE = process.env.ROUTE ?? "nym";
/** With a real signer a person presses its button: each operation then waits for a file named after it in this directory. */
const GATE = process.env.GATE;
const SHOTS = process.env.SHOTS ?? "/tmp";
const STATE = process.env.VAJRA_STACK === "local" ? ".vajra-local" : ".vajra";
const key = readFileSync(new URL(`../../../${STATE}/daily.key`, import.meta.url), "utf8").trim();
const daily = privateKeyToAccount(key);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.exposeBinding("__personalSign", async (_, message) => daily.signMessage({ message: { raw: message } }));
await context.addInitScript(
  ({ address, route }) => {
    if (window.top !== window) return;
    try {
      localStorage.setItem("vajra.reads", route);
    } catch {}
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts") return [address];
        if (method === "personal_sign") return window.__personalSign(params[0]);
        throw new Error(`unsupported ${method}`);
      },
    };
  },
  { address: daily.address, route: ROUTE },
);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const banner = async (cls) => (await page.locator(`.banner.${cls}`).first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
// A mixnet route is much slower than a direct one, and that is expected.
const PATIENCE = ROUTE === "nym" || ROUTE === "tor" ? 3 : 1;
const waitFor = async (fn, what, ms = 150_000) => {
  const end = Date.now() + ms * PATIENCE;
  while (Date.now() < end) {
    if (await fn()) return true;
    await page.waitForTimeout(1000);
  }
  console.log(`  timed out waiting for: ${what}`);
  return false;
};

const started = Date.now();
await page.goto("http://localhost:3000/");
const up = await waitFor(async () => (await page.locator(".big").first().textContent({ timeout: 500 }).catch(() => "")).includes("ETH"), "the balance", 120_000);
check(up, `the balance loaded over ${ROUTE} after ${((Date.now() - started) / 1000).toFixed(0)}s`);
await shot("1-account");

await page.getByRole("button", { name: /Connect wallet/ }).click();
await page.waitForTimeout(800);
check(await page.getByRole("button", { name: /Sign and send/ }).isVisible(), "the wallet connected");
const timed = async (label, work) => {
  const at = Date.now();
  await work();
  console.log(`     ${label}: ${((Date.now() - at) / 1000).toFixed(0)}s`);
};

const spend = async (to, amount) => {
  await page.getByPlaceholder("0x…").fill(to);
  await page.getByPlaceholder("0.0001").fill(amount);
  await page.getByRole("button", { name: "Sign and send" }).click();
};
const idle = () => waitFor(async () => (await page.getByRole("button", { name: /Sign and send|Sending/ }).textContent()) === "Sign and send", "the spend to finish");

/** What went wrong, not counting what the key panel says about the next key. */
const problem = async () => (await page.locator(".banner.error:not(.next-leaf)").first().textContent({ timeout: 500 }).catch(() => null)) ?? "";

/** Asks for a master operation. A prompt nobody pressed comes back as Declined, which costs nothing, so it is asked again. */
const approve = async (op, button, done) => {
  if (GATE) {
    console.log(`ready: ${op}`);
    while (!existsSync(`${GATE}/${op}`)) await page.waitForTimeout(250);
  }
  for (let prompt = 0; prompt < 5; prompt++) {
    await button().click();
    await waitFor(async () => (await done()) || (await problem()) !== "", op);
    if (await done()) return;
    if (!(await problem()).includes("Declined")) return console.log(`${op} failed: ${(await problem()).slice(0, 120)}`);
    console.log(`no press for ${op}, asking again`);
  }
};

const payee = privateKeyToAccount(`0x${"7".repeat(63)}${Date.now() % 10}`).address;
await timed("spend, sign to mined", async () => {
  await spend(payee, "0.00005");
  await page.waitForTimeout(500);
  await idle();
});
check((await banner("ok")).includes("Sent"), `a spend inside the rules went out: ${await banner("ok")}${await banner("error")}`);
await shot("2-spent");

await spend(payee, "0.5");
await page.waitForTimeout(500);
await idle();
check((await banner("ok")).includes("queued"), `an oversized spend was queued: ${(await banner("ok")).slice(0, 70)}${await banner("error")}`);
await waitFor(async () => (await page.getByRole("button", { name: "Veto" }).count()) > 0, "the queue to update", 30_000);
await shot("3-queued");

await approve("veto", () => page.getByRole("button", { name: "Veto" }).first(), async () => (await banner("ok")).includes("Veto"));
check((await banner("ok")).includes("on chain"), `the master key vetoed it: ${await banner("ok")}${await banner("error")}`);

// The page reads Arkiv after an operation. A row that says verified was checked in this browser, not taken from anyone.
const leaves = page.locator(".leaves");
const direct = page.getByRole("button", { name: "Read Arkiv directly" });
if (ROUTE === "nym") {
  check(await waitFor(() => direct.isVisible(), "the question", 15_000), "on the private route the page asks before reading Arkiv");
  check((await leaves.locator("tbody tr").count()) === 0, "and has read nothing until it is told to");
  await direct.click();
}
const veto = leaves.locator("tbody tr", { hasText: "veto" }).first();
await waitFor(async () => (await veto.count()) > 0 || (await leaves.textContent()).includes("did not answer"), "Arkiv to show the veto", 90_000);
check((await veto.count()) > 0 && (await veto.textContent()).includes("signature verified"), `the veto is on Arkiv, verified in this browser: ${(await leaves.locator(".banner").first().textContent({ timeout: 500 }).catch(() => "")).slice(0, 90)}`);
await shot("3b-arkiv");

await approve("freeze", () => page.getByRole("button", { name: "Freeze" }), async () => (await banner("frozen")).includes("Frozen"));
check((await banner("frozen")).includes("Frozen"), "the freeze shows");
await spend(payee, "0.00001");
await waitFor(async () => (await banner("error")).length > 0, "the refusal", 60_000);
check((await banner("error")).includes("AccountFrozen"), `a spend while frozen was refused: ${(await banner("error")).slice(0, 80)}`);
await shot("4-frozen");

await approve("unfreeze", () => page.getByRole("button", { name: "Unfreeze" }), async () => (await banner("frozen")) === "");
check((await banner("frozen")) === "", "the account unfroze");

await page.goto("http://localhost:3000/proof");
await waitFor(async () => (await page.locator(".tag.good").count()) > 3, "live receipts", 60_000);
check((await page.locator("text=on chain now").count()) > 3, `the proof page confirmed ${await page.locator("text=on chain now").count()} transactions live`);
await shot("5-proof");

await page.goto("http://localhost:3000/scanner");
await waitFor(async () => (await page.locator(".reads .dot").getAttribute("class")).match(/ready|exposed/), "reads", 60_000);
await page.fill("textarea", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\n0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2\n0x000000000000000000000000000000000000dEaD");
await page.click("button.primary");
await waitFor(async () => (await page.locator("tbody tr").count()) === 3, "the batch", 90_000);
check((await page.locator("tbody tr").count()) === 3, `the batch scan finished: ${await page.locator("section.card h2").last().textContent().catch(() => "")}`);
await shot("6-scanner");

await page.setViewportSize({ width: 400, height: 820 });
await page.goto("http://localhost:3000/");
const phoneReady = await waitFor(async () => (await page.locator(".big").first().textContent({ timeout: 500 }).catch(() => "")).includes("ETH"), "the account at phone width", 120_000);
check(phoneReady, "the account view rendered at phone width");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check(!overflow, "no horizontal scroll at phone width");
await shot("7-phone");

console.log(`page errors: ${pageErrors.length ? pageErrors.join(" | ") : "none"}`);
console.log(`${failures} failures`);
await browser.close();
process.exit(failures ? 1 : 0);
