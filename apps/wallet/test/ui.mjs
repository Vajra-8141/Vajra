// Clicks through every flow on the FAKE build, at phone and desktop sizes, and screenshots to test/shots/.
// This tests the screens only. Nothing here proves anything about the chain.
//
//   node build.mjs --fake && node test/ui.mjs
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = new URL("../dist-fake/", import.meta.url).pathname;
const shots = new URL("./shots/", import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
if (!existsSync(root)) throw new Error("run `node build.mjs --fake` first");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(root, path === "/" ? "index.html" : path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://localhost:${server.address().port}`;

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const pause = (page, ms) => page.waitForTimeout(ms);

const browser = await chromium.launch({ executablePath: "/usr/bin/brave-browser", headless: true });

async function open(size, name, opts = {}) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, hasTouch: name === "phone", userAgent: opts.ua, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/snarkjs|404/.test(m.text())) errors.push(m.text());
  });
  const shot = async (label) => {
    await pause(page, 480);
    await page.screenshot({ path: `${shots}${name}-${label}.png` });
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (scroll > 0) check(false, `${label}: ${scroll}px of sideways scroll at ${size.width}px`);
  };
  return { context, page, shot, errors };
}

const tap = (page, name, role = "button") => page.getByRole(role, { name, exact: false }).first().click();
const sheetTap = (page, name) => page.getByRole("dialog").getByRole("button", { name }).click();
/** Answers a hash key sheet, waits out the progress, and closes the result. */
async function confirmAndFinish(page, confirm, shot, label) {
  await page.getByRole("dialog").getByRole("button", { name: confirm }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^(Done|Open your safe|Back to Home|Go to Home)$/ }).waitFor({ timeout: 15000 });
  if (shot) await shot(label);
  await page.getByRole("dialog").getByRole("button", { name: /^(Done|Open your safe|Back to Home|Go to Home)$/ }).click();
}

async function onboard(page, shot) {
  await page.goto(`${origin}/`);
  await page.getByRole("heading", { name: /thief can't empty/ }).waitFor();
  await shot("01-welcome");
  await tap(page, "Create a wallet", "link");
  await shot("02-limit");
  await tap(page, "Continue");
  await shot("03-delay");
  await tap(page, "Continue");
  await shot("04-safe");
  await tap(page, "Continue");
  await page.getByLabel("Passphrase", { exact: true }).fill("horse battery staple river");
  await shot("05-passphrase-mismatch-empty");
  await page.getByLabel("Type it again").fill("horse battery staple river");
  await shot("05-passphrase");
  await tap(page, "Make my wallet");
  await page.getByText("Making your hash key").waitFor();
  await pause(page, 1100);
  await page.screenshot({ path: `${shots}${page.viewportSize().width > 500 ? "desktop" : "phone"}-06-making.png` });
  await page.getByRole("heading", { name: "Save your backup" }).waitFor({ timeout: 10000 });
  await shot("07-backup");
  check(await page.getByRole("button", { name: "Go to my wallet" }).isDisabled(), "backup: can't continue before downloading");
  await page.evaluate(() => (location.hash = "/settings"));
  await pause(page, 200);
  check(await page.getByRole("heading", { name: "Save your backup" }).isVisible(), "backup: routes can't skip it");
  const dl = page.waitForEvent("download");
  await tap(page, "Download backup file");
  const file = await dl;
  check(file.suggestedFilename() === "vajra-backup.txt", "backup: file downloads");
  await page.getByRole("checkbox").check();
  await shot("07-backup-saved");
  await page.reload();
  await page.getByLabel("Passphrase").fill("horse battery staple river");
  await tap(page, "Open wallet");
  await page.getByRole("heading", { name: "Save your backup" }).waitFor();
  check(true, "backup: a reload doesn't skip it");
  const dl2 = page.waitForEvent("download");
  await tap(page, "Download backup file");
  await dl2;
  await page.getByRole("checkbox").check();
  await tap(page, "Go to my wallet");
  await page.getByText("Protected", { exact: true }).first().waitFor();
  return file;
}

async function full(size, name, ua) {
  console.log(`\n${name} ${size.width}x${size.height}`);
  const { context, page, shot, errors } = await open(size, name, { ua });
  const backupFile = await onboard(page, shot);
  await shot("08-home");

  // Send: instant
  await tap(page, "Send", "link");
  await pause(page, 300);
  await shot("09-send-empty");
  const to = `0x${"ab12".repeat(10)}`;
  await page.getByLabel("To", { exact: true }).fill(to);
  await page.getByLabel("Amount").fill("0.005");
  await page.getByText("Goes now.").waitFor();
  await shot("10-send-goes-now");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await page.getByRole("heading", { name: "Sent" }).waitFor({ timeout: 8000 });
  await page.getByText("Proof").click();
  await shot("11-send-sent");
  await tap(page, "Back to Home", "link");

  // Send: queued
  await tap(page, "Send", "link");
  await page.getByLabel("To", { exact: true }).fill(to);
  await page.getByLabel("Amount").fill("0.1");
  await page.getByText(/Waits 2 minutes in public/).waitFor();
  await shot("12-send-waits");
  await tap(page, "Send, and let it wait");
  await page.getByRole("heading", { name: "Waiting in public" }).waitFor({ timeout: 8000 });
  await shot("13-send-waiting");
  await tap(page, "Back to Home", "link");
  await page.getByText("Your payment is waiting").waitFor();
  await shot("14-home-queue");
  await tap(page, "Pay, it's me");
  await shot("15-hash-sheet-pay");
  await confirmAndFinish(page, "Pay now");

  // Protection, in order
  await page.evaluate(() => (location.hash = "/protection"));
  await page.getByRole("heading", { name: "Protection" }).waitFor();
  await shot("20-protection");
  await page.locator('[data-step="alerts"] .step-head').click();
  const pushBtn = page.getByRole("button", { name: "Use push" });
  await page.evaluate(() => (window.__fakeFail = "enablePush"));
  await pushBtn.click();
  await page.getByRole("alert").waitFor();
  await shot("21-alerts-failed");
  check(await pushBtn.isEnabled(), "alerts: a failed push isn't shown as on");
  await pushBtn.click();
  await page.getByRole("button", { name: "Start the practice" }).or(page.getByRole("link", { name: "Start the practice" })).waitFor({ timeout: 8000 });
  await shot("22-protection-drill-open");

  // The drill
  await tap(page, "Start the practice", "link");
  await pause(page, 300);
  await shot("23-drill-intro");
  await tap(page, "Start the theft");
  await page.getByText("Did you do this?").waitFor({ timeout: 8000 });
  await shot("24-drill-live");
  await tap(page, "Not me");
  await shot("25-drill-hash-sheet");
  await page.evaluate(() => (window.__fakeFail = "notMe"));
  await sheetTap(page, "Cancel this payment");
  await page.getByRole("heading", { name: "The chain refused this" }).waitFor({ timeout: 8000 });
  await shot("26-failure-sheet");
  check((await page.getByText("Cancelled").count()) === 0, "failure: a failed cancel never shows Cancelled");
  await sheetTap(page, "Try again");
  await page.getByText("Your hash key killed that payment").waitFor({ timeout: 8000 });
  await pause(page, 500);
  await page.getByText("Proof").click();
  await shot("27-drill-cancelled");
  await tap(page, "Next: freeze and unfreeze", "link");

  // Freeze and unfreeze
  await page.getByRole("button", { name: "Freeze now" }).waitFor();
  await tap(page, "Freeze now");
  await shot("28-freeze-sheet");
  await confirmAndFinish(page, "Freeze", shot, "29-frozen-result");
  await page.evaluate(() => (location.hash = "/"));
  await page.getByText("Frozen", { exact: true }).first().waitFor();
  await shot("30-home-frozen");
  await page.evaluate(() => (location.hash = "/protection"));
  await page.getByRole("button", { name: "Unfreeze", exact: true }).click();
  await confirmAndFinish(page, "Unfreeze");

  // Second way out
  await page.locator('[data-step="exit"] .step-head').click();
  await page.getByRole("button", { name: "Set up second way out" }).waitFor();
  await tap(page, "Set up second way out");
  await confirmAndFinish(page, "Set it up");

  // Paper
  await page.locator('[data-step="paper"] .step-head').click();
  await tap(page, "Make my paper", "link");
  await pause(page, 200);
  await shot("31-paper-intro");
  await tap(page, "Make my paper");
  await sheetTap(page, "Make my paper");
  await page.getByTestId("paper").waitFor({ timeout: 10000 });
  await shot("32-paper-shown");
  const paper = await page.getByTestId("paper").innerText();
  check(await page.getByRole("button", { name: "I've written it down" }).isDisabled(), "paper: can't continue without the check");
  await page.getByLabel("last 4 characters").fill("zzzz");
  check(await page.getByRole("button", { name: "I've written it down" }).isDisabled(), "paper: wrong characters are refused");
  await page.getByLabel("last 4 characters").fill(paper.trim().slice(-4));
  await tap(page, "I've written it down");
  await tap(page, "Back to Protection", "link");

  // Move
  await page.locator('[data-step="move"] .step-head').click();
  await tap(page, "Move it to my phone", "link");
  await tap(page, "Show the QR code");
  await page.getByRole("img", { name: /moves your hash key/ }).waitFor();
  await shot("33-move-qr");
  const link = await page.evaluate(async () => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Copy link"));
    button.click();
    await new Promise((r) => setTimeout(r, 100));
    return navigator.clipboard.readText();
  });
  check(link.includes("/#/link/"), "move: link copies");
  await page.getByRole("checkbox").check();
  await tap(page, "It's on my phone");
  await page.getByRole("heading", { name: "Protection" }).waitFor({ timeout: 6000 });
  await shot("34-protection-all-done");

  // With the hash key gone, hash key actions explain where it went
  await page.evaluate(() => (location.hash = "/settings"));
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  await shot("35-settings");
  await tap(page, "Replace hash key");
  await shot("36-hash-key-away");
  check(await page.getByRole("dialog").getByRole("button", { name: "Replace hash key" }).isDisabled(), "hash key away: the action is blocked");
  await sheetTap(page, "Not now");

  // The phone's side, in its own browser state, then back here to escape
  const phone = await open({ width: 390, height: 844 }, `${name}-link`);
  await phone.page.goto(link);
  await phone.page.getByRole("heading", { name: /Bring your hash key/ }).waitFor();
  await phone.shot("37-receive-key");
  await phone.page.getByLabel("Passphrase").fill("horse battery staple river");
  await phone.page.getByRole("button", { name: "Receive hash key" }).click();
  await phone.page.getByRole("heading", { name: "Your hash key is here" }).waitFor({ timeout: 6000 });
  await phone.shot("38-receive-key-done");
  await phone.context.close();
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("vajra.fake.v1"));
    raw.hashKeyHere = true;
    localStorage.setItem("vajra.fake.v1", JSON.stringify(raw));
  });
  await page.reload();
  await page.getByLabel("Passphrase").fill("horse battery staple river");
  await tap(page, "Open wallet");
  await page.evaluate(() => (location.hash = "/"));
  await page.getByText("Protected", { exact: true }).first().waitFor();

  // Receive, private, pool
  await page.evaluate(() => (location.hash = "/receive"));
  await page.getByRole("img", { name: /your address/ }).waitFor();
  await shot("40-receive");
  await page.getByRole("tab", { name: "Private" }).click();
  await page.getByRole("button", { name: "Claim" }).waitFor({ timeout: 6000 });
  await shot("41-receive-private");
  await tap(page, "Claim");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).waitFor({ timeout: 6000 });
  await sheetTap(page, "Done");
  await page.evaluate(() => (location.hash = "/send?code=vajra-abc123"));
  await page.getByLabel("Their private code").waitFor();
  await page.getByLabel("Amount").fill("0.001");
  await shot("42-send-private");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Check it yourself" }).waitFor({ timeout: 6000 });
  await sheetTap(page, "Check it yourself");
  await page.evaluate(() => (location.hash = "/pool"));
  await page.getByRole("heading", { name: "Private pool" }).waitFor();
  await shot("43-pool-empty");
  await tap(page, "Shield a note");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).waitFor({ timeout: 6000 });
  await sheetTap(page, "Done");
  await tap(page, "Unshield");
  await page.getByLabel("Pay it out to").fill(to);
  await shot("44-pool-note");
  await page.getByRole("button", { name: "Pay out", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Check it yourself" }).waitFor({ timeout: 6000 });
  await sheetTap(page, "Check it yourself");
  await pause(page, 300);

  // Activity, offline, unknown
  await page.evaluate(() => (location.hash = "/activity"));
  await page.getByRole("heading", { name: "Activity" }).waitFor();
  await shot("45-activity");
  await page.evaluate(() => (location.hash = "/"));
  await page.evaluate(() => (window.__fakeUnknown = true));
  await page.getByText("Status unknown").first().waitFor({ timeout: 6000 });
  await shot("46-home-unknown");
  const body = await page.locator("main").innerText();
  check(!/\b0 ETH\b/.test(body), "unknown: never written as zero");
  await page.evaluate(() => {
    window.__fakeUnknown = false;
    window.__fakeOffline = true;
  });
  await page.getByText("Can't reach the chain").waitFor({ timeout: 6000 });
  await shot("47-home-offline");
  await page.evaluate(() => (window.__fakeOffline = false));
  await page.getByText("Can't reach the chain").waitFor({ state: "hidden", timeout: 6000 });

  // Escape
  await page.evaluate(() => (location.hash = "/escape"));
  await page.getByRole("button", { name: "Escape now" }).first().waitFor();
  await shot("50-escape");
  await page.getByRole("button", { name: "Escape now" }).first().click();
  check(await page.getByRole("dialog").getByRole("button", { name: "Escape now" }).isDisabled(), "escape: blocked until ESCAPE is typed");
  await page.getByRole("dialog").getByLabel(/Type ESCAPE/).fill("ESCAPE");
  await shot("51-escape-sheet");
  await confirmAndFinish(page, "Escape now", shot, "52-escaped");
  await page.getByRole("heading", { name: "Your safe" }).waitFor();
  await shot("53-safe");
  await page.getByLabel("To", { exact: true }).fill(to);
  await page.getByLabel("Amount").fill("0.01");
  await tap(page, "Send from safe");
  await page.getByText("See it on the explorer").waitFor({ timeout: 6000 });
  await shot("54-safe-sent");
  await page.evaluate(() => (location.hash = "/"));
  await page.getByText("Escaped", { exact: true }).first().waitFor();
  await shot("55-home-escaped");

  // Lock, wrong passphrase, restore, forget
  await page.evaluate(() => (location.hash = "/settings"));
  await tap(page, "Lock");
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  await page.getByLabel("Passphrase").fill("wrong one");
  await tap(page, "Open wallet");
  await page.getByRole("alert").waitFor();
  await shot("56-lock-wrong");
  await page.getByLabel("Passphrase").fill("horse battery staple river");
  await tap(page, "Open wallet");
  await page.getByText("Escaped", { exact: true }).first().waitFor();
  await page.evaluate(() => (location.hash = "/forget"));
  await page.getByRole("heading", { name: "Forget this device" }).waitFor();
  await shot("57-forget");
  check(await page.getByRole("button", { name: "Forget this device" }).isDisabled(), "forget: blocked until confirmed");
  await page.getByRole("checkbox").check();
  await page.getByLabel(/Type FORGET/).fill("FORGET");
  await page.getByRole("button", { name: "Forget this device" }).click();
  await page.getByRole("heading", { name: /thief can't empty/ }).waitFor();
  check(true, "forget: back at Welcome");

  await tap(page, "Restore from backup", "link");
  await pause(page, 300);
  await shot("60-restore");
  const backupPath = await backupFile.path();
  await page.getByTestId("file").setInputFiles({ name: "vajra-backup.txt", mimeType: "text/plain", buffer: Buffer.from(await (await import("node:fs/promises")).readFile(backupPath)) });
  await page.getByLabel("Passphrase").fill("nope nope");
  await tap(page, "Restore wallet");
  await page.getByRole("heading", { name: "Wrong passphrase" }).waitFor({ timeout: 8000 });
  await shot("61-restore-failed");
  await sheetTap(page, "Close");
  await page.getByLabel("Passphrase").fill("horse battery staple river");
  await tap(page, "Restore wallet");
  await page.getByText("Protected", { exact: true }).first().waitFor({ timeout: 8000 });
  check(true, "restore: straight to Home");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  await context.close();
}

async function recoverFlow(size, name) {
  console.log(`\n${name} recover`);
  const { context, page, shot, errors } = await open(size, name);
  await page.goto(`${origin}/#/recover`);
  await page.getByRole("heading", { name: "Recover with paper" }).waitFor();
  await page.getByLabel("Your recovery paper").fill("one two three four");
  await page.getByLabel("Your account address").fill(`0x${"cd34".repeat(10)}`);
  await page.getByLabel("New passphrase").fill("another long passphrase here");
  await page.getByLabel("Type it again").fill("another long passphrase here");
  await shot("70-recover");
  await tap(page, "Start recovery");
  await page.getByRole("heading", { name: "Recovery is waiting" }).waitFor({ timeout: 12000 });
  await shot("71-recovering");
  await page.getByRole("heading", { name: "Your account is back" }).waitFor({ timeout: 15000 });
  await page.getByText("Proof").click();
  await shot("72-recovered");
  await tap(page, "Go to my wallet");
  await page.getByRole("heading", { name: "Save your backup" }).waitFor();
  check(true, "recover: a recovered wallet must back up before Home");

  // A locked browser can still reach recovery, and has to clear the old wallet first
  await page.reload();
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  await tap(page, "Forgot it", "link");
  await page.getByRole("button", { name: "Remove locked wallet" }).waitFor();
  await shot("73-recover-locked");
  check(await page.getByRole("button", { name: "Remove locked wallet" }).isDisabled(), "recover: clearing a locked wallet needs a tick");
  await page.getByRole("checkbox").check();
  await tap(page, "Remove locked wallet");
  await page.getByLabel("Your recovery paper").waitFor();
  check(true, "recover: the form opens once the locked wallet is gone");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  await context.close();
}

async function narrow() {
  console.log("\n360 wide, iPhone");
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const { context, page, shot } = await open({ width: 360, height: 640 }, "narrow", { ua: iphone });
  await onboard(page, shot);
  await page.getByText("Add VAJRA to your Home Screen").waitFor();
  await shot("80-home-install-hint");
  await page.evaluate(() => {
    localStorage.removeItem("vajra.fake.v1");
    location.hash = "/";
  });
  await page.reload();
  const recoverLink = page.getByRole("link", { name: "Recover with paper" });
  await recoverLink.waitFor();
  check((await recoverLink.boundingBox()).y + 44 <= 640, "welcome: all three choices fit on a short phone");
  await shot("80-welcome-short");
  await onboard(page, shot);
  await page.evaluate(() => (location.hash = "/protection"));
  await page.getByRole("heading", { name: "Protection" }).waitFor();
  await shot("81-protection");
  await page.evaluate(() => (location.hash = "/queue"));
  await page.getByText("Nothing is waiting").waitFor();
  await shot("82-queue-empty");
  await page.evaluate(() => (location.hash = "/"));
  await page.getByRole("button", { name: "Dismiss" }).click();
  check((await page.getByText("Add VAJRA to your Home Screen").count()) === 0, "install hint: dismisses");
  await context.close();
}

try {
  const only = process.env.ONLY;
  if (!only || only === "phone") await full({ width: 390, height: 844 }, "phone");
  if (!only || only === "desktop") await full({ width: 1280, height: 800 }, "desktop");
  if (!only || only === "recover") await recoverFlow({ width: 390, height: 844 }, "phone");
  if (!only || only === "narrow") await narrow();
} catch (e) {
  failures++;
  console.error(`\nFAIL ${e.message}`);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${failures ? `${failures} failed` : "all passed"}`);
process.exit(failures ? 1 : 0);
