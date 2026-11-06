// The static proof page, served from out/ with nothing else running. It must show every recorded file with an honest label, and must
// ask nothing of anyone: any request that leaves this server fails the test.
//   pnpm --filter @vajra/dashboard run export:proof && node apps/dashboard/test/export.mjs
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const out = new URL("../out/", import.meta.url).pathname;
const evidence = new URL("../../../docs/evidence/", import.meta.url).pathname;
const SHOTS = process.env.SHOTS ?? "/tmp";
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain" };

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(out, path === "/" ? "index.html" : path);
  if (!file.startsWith(out) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const elsewhere = [];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/*", (route) => {
  if (route.request().url().startsWith(BASE)) return route.continue();
  elsewhere.push(route.request().url());
  return route.abort();
});

await page.goto(BASE);
await page.locator(".record").first().waitFor({ timeout: 15_000 });
await page.waitForTimeout(1500);

const files = readdirSync(evidence).filter((name) => name.endsWith(".json"));
const shown = await page.locator(".record").evaluateAll((els) => els.map((el) => el.dataset.file));
check(files.every((file) => shown.includes(file)) && shown.length === files.length, `all ${files.length} records in docs/evidence are on the page`);

const origin = async (file) => page.locator(`.record[data-file="${file}"]`).getAttribute("data-origin");
check((await origin("e2e-latest.json")) === "public", "a public run after the reset says so");
check((await origin("device-esp32-latest.json")) === "public-before-reset", "a run before the reset says it cannot be looked up");
check((await origin("arkiv-latest.json")) === "public-before-reset", "so does the Arkiv record");
check((await origin("recovery-latest.json")) === "mirror", "a mirror run is not presented as public");
check((await page.locator('[data-origin-group="unknown"]').count()) === 0, "nothing is left unlabelled");

const body = await page.locator("body").textContent();
check(body.includes("not public evidence"), "the mirror group says it is not public evidence");
check(body.includes("This is not hardware"), "the emulator is not passed off as a device");
check(body.includes("scripted stand-in, not the MetaMask extension"), "the scripted wallet is named as one");
check(body.includes("Nothing on this page is live"), "the page says it is not live");
check(!body.includes("on chain now"), "and claims no live check");
check((await page.locator("button, input, select").count()) === 0, "it has no controls at all");

const raw = await page.request.get(`${BASE}/evidence/e2e-latest.json`);
check(raw.ok(), "the raw records are served beside it");
check(elsewhere.length === 0, `no request left the server: ${elsewhere.slice(0, 3).join(" ") || "none"}`);
await page.screenshot({ path: `${SHOTS}/13-static-proof.png` });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll at phone width");

console.log(`page errors: ${errors.length ? errors.join(" | ") : "none"}\n${failures} failures`);
await browser.close();
server.close();
process.exit(failures || errors.length ? 1 : 0);
