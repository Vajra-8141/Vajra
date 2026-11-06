// Run against the mirror with `make dashboard` up. The thief's terminal and the master key act in other processes, as a phone tap
// does: `vajra veto` goes through the same runMasterOp as the watcher. The page has to show both, and stay free of false alarms.
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const vajra = (...args) => execFileSync("node", ["packages/cli/src/main.ts", ...args], { cwd: new URL("../../../", import.meta.url).pathname, env: { ...process.env, VAJRA_STACK: "local" }, encoding: "utf8" });
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:3000/");
const panel = page.locator(".signed");
await panel.waitFor({ timeout: 60_000 });
const until = async (test, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(500)) if (await test()) return true;
  return false;
};

const before = await panel.textContent();
vajra("thief", "0.2");
check(await until(async () => (await panel.textContent()) !== before && (await panel.locator("> div").nth(0).textContent()).includes("gas to verify")), "the thief's signature shows on the Daily key row");
check(await until(async () => (await page.getByRole("button", { name: "Not me, cancel" }).count()) > 0), "the alarm is up");
const id = (await page.locator(".item .sub").first().textContent()).match(/Item (\d+)/)[1];
vajra("veto", id);
check(await until(async () => (await panel.locator("> div").nth(1).textContent()).includes("gas to verify")), "the veto shows on the Master key row");
check(await until(async () => (await page.getByRole("button", { name: "Not me, cancel" }).count()) === 0), "the alarm cleared");
await page.waitForTimeout(12_000);
const banners = await page.locator(".banner.error").allTextContents();
check(banners.length === 0, `no false alarm after the outside signature: ${banners.join(" | ") || "none"}`);
console.log((await panel.textContent()).replace(/\s+/g, " "));
await page.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/signed.png` });
console.log(`page errors: ${errors.length ? errors.join(" | ") : "none"}\n${failures} failures`);
await browser.close();
process.exit(failures ? 1 : 0);
