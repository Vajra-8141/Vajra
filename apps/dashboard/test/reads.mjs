// How long each read route takes to come up in a real browser, and whether a read really goes through it.
import { chromium } from "playwright-core";

const SHOTS = process.env.SHOTS ?? "/tmp";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const route of (process.env.ROUTES ?? "passthrough,tor,nym").split(",")) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 180)));
  await page.addInitScript((r) => localStorage.setItem("vajra.reads", r), route);
  const started = Date.now();
  await page.goto(`${process.env.BASE ?? "http://localhost:3000"}/scanner`);
  const dot = page.locator(".reads .dot");
  let state = "starting";
  while (Date.now() - started < Number(process.env.LIMIT ?? 75_000)) {
    state = (await dot.getAttribute("class")).replace("dot ", "");
    if (state !== "starting") break;
    await page.waitForTimeout(500);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const banner = await page.locator(".banner").first().textContent({ timeout: 500 }).catch(() => "");
  let lookup = "not tried";
  if (state === "ready" || state === "exposed") {
    await page.fill("textarea", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    await page.click("button.primary");
    await page.waitForSelector("section.card h2", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(6000);
    lookup = await page.locator("section.card").nth(1).textContent({ timeout: 2000 }).catch(() => "no result");
  }
  console.log(`${route}: ${state} after ${elapsed}s | banner: ${(banner ?? "").slice(0, 150)} | lookup: ${(lookup ?? "").slice(0, 120)} | errors: ${errors.length ? errors[0] : "none"}`);
  await page.screenshot({ path: `${SHOTS}/reads-${route}.png` });
  await context.close();
}
await browser.close();
