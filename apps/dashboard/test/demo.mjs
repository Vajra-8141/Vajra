// The no-setup demo, in a real browser against the mirror, with no wallet in the page at all. Run with the mirror, the bridge and the
// dashboard up. Everything checked here came back from the chain, the mempools or the sidecar: nothing is stubbed.
//   BASE=http://localhost:3100 SHOTS=docs/screenshots node apps/dashboard/test/demo.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const shot = (name, fullPage = true) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
const until = async (test, ms = 45_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(300)) if (await test().catch(() => false)) return true;
  return false;
};
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const step = (n) => page.locator(`[data-step="${n}"]`);
const ticked = (n) => step(n).evaluate((el) => el.classList.contains("done"));

// Start from a known place: a new account, through the page's own button.
await page.goto(`${BASE}/`);
await page.getByRole("heading", { name: /stole your wallet key/ }).waitFor({ timeout: 90_000 });
check(await until(() => step(1).isVisible()), "the page opens on the story");
await page.getByRole("button", { name: "Start over with a new account" }).click();
check(await until(async () => (await ticked(1)) && !(await ticked(2)) && !(await ticked(3)), 60_000), "a new account starts with only step 1 ticked");
check((await page.locator(".demo-note").textContent()).includes("Demo signer"), "the demo signer is labelled plainly");
check(await page.evaluate(() => window.ethereum === undefined), "no wallet exists in this browser");

// A glossary term opens by click, and says something.
const term = page.locator(".lead .term-word").first();
await term.click();
check((await page.locator(".term-tip").first().textContent()).length > 30, "a glossary term explains itself on click");
await shot("01-story-start", false);
await page.keyboard.press("Escape");
await page.mouse.move(0, 0);

await page.getByRole("button", { name: /Pay the shop/ }).click();
check(await until(() => ticked(2)), "step 2 ticks once the payment is on chain");
check(await until(async () => (await step(2).textContent()).includes("Mined in block")), "the everyday payment reports its block");

await page.getByRole("button", { name: /Steal 0.5 ETH as the thief/ }).click();
check(await until(() => ticked(3)), "step 3 ticks once the theft is in the queue");
check(await until(async () => (await page.locator(".cheque-amount").textContent()).includes("0.5 ETH")), "the cheque shows the queued amount from the chain");
check(await until(async () => (await step(3).textContent()).includes("Not refused, and not paid")), "the theft was queued, not paid");
check(await ticked(4), "step 4 ticks with the alert on screen");
check((await page.locator(".phone").textContent()).includes("No message is sent"), "the phone says it is a stand-in");
await shot("02-theft-queued");

await page.getByRole("button", { name: "Not me, cancel" }).click();
check(await until(() => ticked(5)), "one tap cancels: step 5 ticks from the chain's item state");
check(await until(async () => (await page.locator(".cheque .stamp.red").textContent()).toLowerCase().includes("cancelled")), "the cheque is stamped cancelled");
await page.waitForTimeout(400);
await shot("03-cancelled");

await page.getByRole("button", { name: "Replace the hash key as the thief" }).click();
check(await until(() => ticked(6)), "step 6 ticks on a real refusal");
check((await step(6).locator(".stamp").textContent()).includes("EscapeKeyOutranks"), "the named refusal is on screen");
await page.waitForTimeout(400);
await shot("04-story-done");

// A reload keeps what the chain and the bridge remember.
await page.reload();
check(await until(async () => (await ticked(3)) && (await ticked(5)) && (await ticked(6))), "the ticks survive a reload");

// Break in: every attack, for real. Queue a payment first, so that the early execute has something to try.
await page.getByRole("button", { name: /Steal 0.5 ETH again/ }).click();
await until(async () => (await page.getByRole("button", { name: "Not me, cancel" }).count()) > 0);
await page.goto(`${BASE}/break-in`);
const runAll = page.getByRole("button", { name: "Run every attack" });
await runAll.waitFor({ timeout: 60_000 });
await runAll.click();
check(await until(async () => (await page.locator(".attack .stamp").count()) >= 17 && (await runAll.isEnabled()), 150_000), "all 17 attacks came back with a stamp");
const tally = (await page.locator(".tally").textContent()).replace(/\s+/g, " ");
check(tally.includes("0 got in"), `nothing got in: ${tally.slice(0, 50)}`);
for (const [id, name] of [["escape", "EscapeKeyOutranks"], ["harbor", "HarborImmutable"], ["burn-leaf", "DailyNonceKeyInvalid"], ["fee-burn", "DailyTxCostExceeded"], ["stranger", "NotDailyKey"], ["frozen", "AccountFrozen"], ["execute-early", "QueuedPendingTimelock"]]) {
  check((await page.locator(`[data-attack="${id}"] .stamp`).textContent()).includes(name), `${id} is refused as ${name}`);
}
await page.locator('[data-attack="escape"] summary').click();
check((await page.locator('[data-attack="escape"] .raw').textContent()).includes("reverted with data"), "the raw node error is there to read");
await page.waitForTimeout(300);
await shot("05-break-in");

// Mempools: the same transaction, both ways, with raw errors and bars.
await page.goto(`${BASE}/mempool`);
const send = page.getByRole("button", { name: /Send to both mempools|Run it again/ });
await send.waitFor({ timeout: 60_000 });
const lane = (name) => page.locator(`[data-lane="${name}"]`);
const lab = async (title, canonical, alt, text) => {
  await page.getByRole("radio", { name: title }).click();
  await send.click();
  await until(async () => (await send.isEnabled()) && (await page.locator(".lab-result").count()) > 0, 60_000);
  const left = (await lane("canonical").textContent()).toLowerCase();
  const right = (await lane("alt").textContent()).toLowerCase();
  check(left.includes(canonical) && right.includes(alt), `${title}: canonical ${canonical}, alt ${alt}`);
  check((left + right).includes(text.toLowerCase()), `  raw error includes "${text}"`);
};
await lab(/A thief holds the slot/, "refused", "admitted", "other nonce-key domain");
check((await page.locator(".frame").count()) >= 2, "per-frame gas bars are drawn");
check(/[\d,]+ used of [\d,]+ declared/.test(await page.locator(".frame.verify .frame-numbers").first().textContent()), "the VERIFY bar reports real gas");
await page.waitForTimeout(300);
await shot("06-mempool-pin");
await lab(/Staked sender, 400,000/, "refused", "admitted", "MAX_VERIFY_GAS");
await lab(/Unstaked sender, 400,000/, "refused", "refused", "MAX_VERIFY_GAS_PER_ENTITY");
await page.waitForTimeout(300);
await shot("07-mempool-budget");
await lab(/Staked sender, 1,100,000/, "refused", "refused", "MAX_VERIFY_GAS_STAKED_ENTITY");

// Lifecycle: from the sidecar, including a real Cancelled.
await page.goto(`${BASE}/lifecycle`);
await page.locator(".life").first().waitFor({ timeout: 30_000 });
const race = page.getByRole("button", { name: "Lose a race on purpose" });
await race.click();
check(await until(async () => (await page.locator('.life[data-outcome="dropped"]').count()) > 0, 30_000), "a real transaction shows as Cancelled");
await page.locator('.life[data-outcome="dropped"] .life-reason').first().waitFor({ timeout: 15_000 });
const reason = (await page.locator('.life[data-outcome="dropped"] .life-reason').first().textContent()).trim();
check(reason.length > 10 && !reason.includes("gave no reason"), `with the sidecar's reason: ${reason.slice(0, 90)}`);
check((await page.locator(".plain .result").first().textContent()).includes("ended as Cancelled"), `the race's loser reports its own status: ${(await page.locator(".plain .result").first().textContent()).slice(0, 120)}`);
check((await page.locator('.life[data-outcome="included"]').count()) > 0, "and mined transactions show as Mined");
check((await page.locator(".reputation tbody tr").count()) > 0, "reputation rows come from the sidecar");
check((await page.locator(".reputation").textContent()).includes("ok"), "with a status");
await page.waitForTimeout(300);
await shot("08-lifecycle", false);

// Clear the queue this test left behind, then check the end of the story: the escape, and going again.
await page.goto(`${BASE}/`);
await page.getByRole("button", { name: "Not me, cancel" }).click();
await until(() => ticked(5));
await page.getByRole("button", { name: "Escape to harbor" }).click();
await page.getByRole("button", { name: "Confirm escape" }).click();
check(await until(async () => (await page.locator(".endgame").textContent()).includes("Escaped in"), 60_000), "the escape mined");
await page.getByRole("button", { name: "Start over with a new account" }).click();
check(await until(async () => (await ticked(1)) && !(await ticked(3)), 60_000), "and the demo can go again");

await page.goto(`${BASE}/proof`);
await page.locator(".record").first().waitFor({ timeout: 60_000 });
check((await page.locator('[data-origin-group="mirror"]').count()) === 1 && (await page.locator('[data-origin-group="public"]').count()) === 1, "the proof page separates mirror runs from public ones");
check(!(await page.locator("body").textContent()).includes("on chain now"), "the mirror does not claim to have checked public hashes");
await shot("09-proof", false);

// Phone width: the theft and the tap, then every page.
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/`);
await step(1).waitFor({ timeout: 60_000 });
check(await until(async () => (await step(1).evaluate((el) => el.getBoundingClientRect().top)) < 900 && !(await page.locator(".cheque").isVisible())), "on a phone, no blank cheque stands in front of the steps");
await page.getByRole("button", { name: /Steal 0.5 ETH/ }).click();
const inView = async () => page.locator(".phone-alert button").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
check(await until(async () => (await page.locator(".phone-alert").count()) > 0 && (await inView()), 45_000), "after the theft, the alert's button is on screen");
await shot("10-phone-alert", false);
await page.getByRole("button", { name: "Not me, cancel" }).click();
check(await until(() => ticked(5)), "one tap cancels it at phone width");
await page.waitForTimeout(400);
await shot("11-phone-cancelled", false);
for (const [path, name] of [["/", null], ["/account", null], ["/break-in", null], ["/mempool", null], ["/lifecycle", null], ["/scanner", null], ["/proof", null]]) {
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(2500);
  check(await noOverflow(), `no horizontal scroll at phone width on ${path}`);
  if (name) await shot(name, false);
}

console.log(`page errors: ${errors.length ? errors.join(" | ") : "none"}\n${failures} failures`);
await browser.close();
process.exit(failures || errors.length ? 1 : 0);
