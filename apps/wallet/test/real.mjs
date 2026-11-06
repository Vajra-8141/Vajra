// The real build, in a real browser, on the public chain, through a running server.ts. No fake anywhere. Spends test ETH.
//   node build.mjs && URL=http://localhost:8791 node test/real.mjs
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
const origin = process.env.URL ?? "http://localhost:8791";
const shots = new URL("./shots/real/", import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
const PASS = "horse battery staple river";
// A wallet costs test ETH, so a rerun picks up the last one from its backup.
const SAVED = new URL("../../../.vajra-wallet/test-backup.txt", import.meta.url).pathname;
const FROM = process.env.FROM ?? "start";
let fails = 0;
const t0 = Date.now();
const say = (l) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${l}`);
const browser = await chromium.launch({ executablePath: "/usr/bin/brave-browser", headless: true });
async function device(name, size) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => { fails++; console.log(`  PAGE ERROR (${name}):`, e.message.slice(0, 200)); });
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) console.log(`  console (${name}):`, m.text().slice(0, 200)); });
  return { page, shot: (l) => page.screenshot({ path: `${shots}${name}-${l}.png` }) };
}
const tap = (p, name, role = "button") => p.getByRole(role, { name, exact: false }).first().click();
const sheet = (p, name) => p.getByRole("dialog").getByRole("button", { name }).click();
const closeSheet = async (p, timeout = 120000) => {
  const b = p.locator("button, a").filter({ hasText: /^(Done|Open your safe|Back to Home|Go to Home)$/ }).first();
  await b.waitFor({ timeout });
  await b.click();
};
const route = (p, h) => p.evaluate((x) => (location.hash = x), h);

const laptop = await device("laptop", { width: 1280, height: 800 });
const phone = await device("phone", { width: 390, height: 844 });
const p = laptop.page;
try {
  if (existsSync(SAVED) && FROM !== "start") {
    await p.goto(`${origin}/`);
    await p.evaluate(([sealed]) => {
      localStorage.setItem("vajra.wallet.v1", JSON.stringify({ sealed: JSON.parse(sealed), account: "0x0000000000000000000000000000000000000000" }));
      location.reload();
    }, [readFileSync(SAVED, "utf8")]);
    await p.getByLabel("Passphrase").fill(PASS);
    await tap(p, "Open wallet");
    await p.getByText("Protected", { exact: true }).first().waitFor({ timeout: 30000 });
    say("opened the saved wallet");
  } else {
  await p.goto(`${origin}/`);
  await p.getByRole("heading", { name: /thief can't empty/ }).waitFor();
  await tap(p, "Create a wallet", "link");
  for (let i = 0; i < 3; i++) await tap(p, "Continue");
  await p.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await p.getByLabel("Type it again").fill(PASS);
  await tap(p, "Make my wallet");
  await p.getByRole("heading", { name: "Save your backup" }).waitFor({ timeout: 60000 });
  say("wallet created through the screens");
  const dl = p.waitForEvent("download");
  await tap(p, "Download backup file");
  await (await dl).saveAs(SAVED);
  await p.getByRole("checkbox").check();
  await tap(p, "Go to my wallet");
  await p.getByText("Protected", { exact: true }).first().waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  await laptop.shot("01-home");
  say("home shows the real wallet");

  await route(p, "/send");
  await p.getByLabel("To", { exact: true }).fill("0x000000000000000000000000000000000000dEaD");
  await p.getByLabel("Amount").fill("0.001");
  await p.waitForTimeout(1500);
  await p.getByRole("button", { name: /^Send$/ }).click();
  await p.getByRole("heading", { name: "Sent" }).waitFor({ timeout: 90000 });
  await laptop.shot("02-sent");
  await closeSheet(p);
  say("instant send mined");

  await route(p, "/drill");
  await tap(p, "Start the theft");
  await p.getByText("Did you do this?").waitFor({ timeout: 90000 });
  await laptop.shot("03-drill");
  say("practice theft queued on chain");
  await tap(p, "Not me");
  await sheet(p, "Cancel this payment");
  await p.getByText("Your hash key killed that payment").waitFor({ timeout: 120000 });
  await p.waitForTimeout(800);
  await laptop.shot("04-cancelled");
  say("Not me mined");

  }

  // Things only a browser can prove: proofs on the device, and the stealth keys.
  await route(p, "/protection");
  await p.getByRole("heading", { name: "Protection" }).waitFor();
  await p.locator('[data-step="freeze"] .step-head').click();
  await p.getByRole("button", { name: "Freeze now" }).waitFor({ timeout: 20000 });
  await tap(p, "Freeze now");
  await sheet(p, "Freeze");
  await closeSheet(p);
  await route(p, "/");
  await p.getByText("Frozen", { exact: true }).first().waitFor({ timeout: 30000 });
  await laptop.shot("04b-frozen");
  await route(p, "/protection");
  await p.locator('[data-step="freeze"] .step-head').click();
  await p.getByRole("button", { name: "Unfreeze", exact: true }).click();
  await sheet(p, "Unfreeze");
  await closeSheet(p);
  say("froze and unfroze through the screens");

  await route(p, "/pool");
  await p.getByRole("heading", { name: "Private pool" }).waitFor();
  await tap(p, "Shield a note");
  if (await p.getByRole("dialog").getByRole("button", { name: /Shield/ }).isVisible().catch(() => false)) await sheet(p, /Shield/);
  await closeSheet(p);
  say("shielded a note");
  await p.waitForTimeout(5000);
  await tap(p, "Unshield");
  await p.getByLabel("Pay it out to").fill("0x000000000000000000000000000000000000dEaD");
  await p.getByRole("button", { name: "Pay out", exact: true }).click();
  await closeSheet(p, 180000);
  await laptop.shot("04c-unshielded");
  say("unshielded with a proof made in the browser");

  await route(p, "/receive");
  await p.getByRole("tab", { name: "Private" }).click();
  const copied = await p.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 2500));
    [...document.querySelectorAll("button")].find((b) => /copy/i.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 300));
    return navigator.clipboard.readText();
  });
  say(`private code copied, ${copied.length} characters`);
  await route(p, `/send?code=${copied.replace(/^.*[=/]/, "")}`);
  await p.getByLabel("Their private code").waitFor();
  await p.getByLabel("Amount").fill("0.0005");
  await p.waitForTimeout(800);
  await p.getByRole("button", { name: /^Send$/ }).click();
  await closeSheet(p, 120000);
  say("sent privately");
  await route(p, "/receive");
  await p.getByRole("tab", { name: "Private" }).click();
  await p.getByRole("button", { name: "Claim" }).waitFor({ timeout: 60000 });
  await laptop.shot("04d-private-found");
  await tap(p, "Claim");
  await closeSheet(p, 120000);
  say("claimed the private payment");

  await route(p, "/move");
  await tap(p, "Show the QR code");
  await p.getByRole("img", { name: /moves your hash key/ }).waitFor();
  const link = await p.evaluate(async () => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Copy link")).click();
    await new Promise((r) => setTimeout(r, 200));
    return navigator.clipboard.readText();
  });
  say(`move link ${link.length} characters`);
  await phone.page.goto(link);
  await phone.page.getByLabel("Passphrase").fill(PASS);
  await phone.page.getByRole("button", { name: "Receive hash key" }).click();
  await phone.page.getByRole("heading", { name: "Your hash key is here" }).waitFor({ timeout: 30000 });
  await p.getByRole("checkbox").check();
  await tap(p, "It's on my phone");
  await p.getByRole("heading", { name: "Protection" }).waitFor({ timeout: 10000 });
  say("hash key moved to the phone");
  await tap(phone.page, "Open wallet", "link");
  await phone.page.waitForTimeout(3000);
  await phone.shot("05-phone-home");

  await route(p, "/drill");
  await tap(p, "Start the theft");
  await p.getByText("Did you do this?").waitFor({ timeout: 90000 });
  say("theft on the laptop, watching the phone");
  await phone.page.getByText("Did you do this?").waitFor({ timeout: 30000 });
  await phone.shot("06-phone-alert");
  await tap(phone.page, "Not me");
  await sheet(phone.page, "Cancel this payment");
  await closeSheet(phone.page).catch(async () => { await phone.shot("06b-phone"); throw new Error("phone cancel did not finish"); });
  await phone.page.waitForTimeout(800);
  await phone.shot("07-phone-cancelled");
  say("the phone cancelled the laptop's theft");
  await p.waitForTimeout(6000);
  await laptop.shot("08-laptop-after");
} catch (e) {
  fails++;
  console.log("FAILED:", e.message.slice(0, 400));
  await laptop.shot("zz-fail").catch(() => {});
  await phone.shot("zz-fail").catch(() => {});
}
await browser.close();
console.log(fails ? `${fails} problems` : "all passed");
process.exit(fails ? 1 : 0);
