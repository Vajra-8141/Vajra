// The first-run checklist, with the bridge really stopped. Run with the mirror and the dashboard up and no bridge: this starts one
// itself, by PID, and watches the page recover with no reload. The last part blocks the mirror's ports in the browser to see the
// list a judge gets before `make judge`.
//   BASE=http://localhost:3100 VAJRA_LANE=1 node apps/dashboard/test/firstrun.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
const LANE = Number(process.env.VAJRA_LANE ?? 0);
const SHOTS = process.env.SHOTS ?? "/tmp";
const root = new URL("../../../", import.meta.url).pathname;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const until = async (test, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(300)) if (await test().catch(() => false)) return true;
  return false;
};

await page.goto(`${BASE}/`);
const list = page.locator(".firstrun");
check(await until(() => list.isVisible()), "with the bridge stopped, the page shows the checklist");
const text = await list.textContent();
check(text.includes("make dashboard"), "and names the command that fixes it");
check(!(await page.locator("body").textContent()).includes("is not running"), "the old dead end is gone");
check(await until(async () => (await page.locator('[data-check="chain"]').getAttribute("class")).includes("ok")), "the mirror's line is ticked, since the chain is up");
await page.screenshot({ path: `${SHOTS}/12-first-run.png` });

for (const path of ["/account", "/break-in", "/mempool"]) {
  await page.goto(`${BASE}${path}`);
  check(await until(() => list.isVisible()), `${path} gives the same next step`);
}

await page.goto(`${BASE}/`);
await until(() => list.isVisible());
const bridge = spawn("node", ["packages/cli/src/main.ts", "bridge"], { cwd: root, env: { ...process.env, VAJRA_STACK: "local" }, stdio: "ignore" });
check(await until(async () => (await page.locator(".firstrun").count()) === 0 && (await page.locator('[data-step="1"]').isVisible())), "the list clears by itself once the bridge starts, with no reload");
bridge.kill();

const blocked = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const port of [18545 + LANE * 100, 14337 + LANE * 100, 8787 + LANE * 100]) await blocked.route(`http://127.0.0.1:${port}/**`, (route) => route.abort());
await blocked.goto(`${BASE}/`);
await blocked.locator('[data-check="chain"].todo').waitFor({ timeout: 30_000 });
check((await blocked.locator(".firstrun").textContent()).includes("make judge"), "with nothing running, the first step is make judge");
check((await blocked.locator(".firstrun .command").count()) === 1, "and only the first open line shows a command");

console.log(`${failures} failures`);
await browser.close();
process.exit(failures ? 1 : 0);
