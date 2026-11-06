// A dashboard built for the public chain must not offer the demo signer. Run a `next dev` without VAJRA_STACK on another port. Every
// request leaving this machine is blocked in the browser, and the bridge is stubbed to answer as a public-chain one, so this test
// sends nothing to any chain.
//   BASE=http://localhost:3199 VAJRA_LANE=1 node apps/dashboard/test/public-page.mjs
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
const demoCalls = [];
const account = "0x1111111111111111111111111111111111111111";
const answers = {
  "/health": { stack: "public", expectedChainId: 1337, execution: { ok: true, chainId: 1337, error: null }, sidecar: { ok: true, chainId: 1337, error: null }, deployed: true, stale: false, account, demo: { available: false, reason: "the demo signer exists on the local mirror only", dailyKey: null }, demoAccount: null },
  "/status": { signer: "software", connected: true, root: null, leavesLeft: 10, harbor: null, account, rootMatches: true, nextLeaf: 1, registryWriter: null },
  "/signed": { daily: null, master: null },
};
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === "localhost") return route.continue();
  if (url.hostname === "127.0.0.1") {
    if (/^\/(demo|attacks|lab)/.test(url.pathname)) demoCalls.push(url.pathname);
    const body = answers[url.pathname];
    return body ? route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } }) : route.abort();
  }
  return route.abort();
});

await page.goto(`${BASE}/story`);
await page.getByRole("heading", { name: /stole your wallet key/ }).waitFor({ timeout: 90_000 });
await page.waitForTimeout(3000);
const body = await page.locator("body").textContent();
for (const name of [/Pay the shop/, /as the thief/, /Start over/, /Escape to harbor/]) check((await page.getByRole("button", { name }).count()) === 0, `the story offers no ${name.source} button`);
check(!body.includes("Local mirror"), "the page does not call itself the mirror");
check(!(await page.locator(".demo-note").count()), "no demo signer note");

await page.goto(`${BASE}/break-in`);
await page.waitForTimeout(2000);
check((await page.getByRole("button", { name: "Run every attack" }).count()) === 0, "the break-in panel has no buttons");
check((await page.locator("body").textContent()).includes("local mirror only"), "and says why");
await page.goto(`${BASE}/mempool`);
await page.waitForTimeout(2000);
check((await page.getByRole("button", { name: /Send to both/ }).count()) === 0, "the mempool panel has no buttons");
check(demoCalls.length === 0, `the page asked for no demo route: ${demoCalls.join() || "none"}`);

console.log(`${failures} failures`);
await browser.close();
process.exit(failures ? 1 : 0);
