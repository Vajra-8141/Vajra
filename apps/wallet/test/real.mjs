// The real build, in a real browser, on the public chain, through a running server.ts. No fake anywhere. Spends test ETH.
//   node build.mjs && URL=http://localhost:8791 node test/real.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
const origin = process.env.URL ?? "http://localhost:8791";
const shots = new URL("./shots/real/", import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
const PASS = "horse battery staple river";
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
  await dl;
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
