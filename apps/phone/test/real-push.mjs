// Web Push with nothing stood in for: a theft on the mirror, the self-hosted VAPID sender, the browser vendor's real push service, and the
// real service worker putting up a notification. It needs Brave, with its Google push option on in a throwaway profile, and internet.
// The first subscribe takes a minute or two while the browser registers.
//
//   VAJRA_LANE=2 VAJRA_STACK=local node apps/phone/test/real-push.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

if (process.env.VAJRA_STACK !== "local") throw new Error("run this on the mirror, with VAJRA_STACK=local");
const repo = new URL("../../../", import.meta.url).pathname;
const main = join(repo, "packages/cli/src/main.ts");
const rpcUrl = `http://127.0.0.1:${18545 + Number(process.env.VAJRA_LANE ?? 0) * 100}`;
const PORT = 3212;
const origin = `http://localhost:${PORT}`;
const { generatePrivateKey, privateKeyToAccount } = await import(new URL("../../../packages/cli/node_modules/viem/_esm/accounts/index.js", import.meta.url));
const { createPublicClient, createWalletClient, http, parseEther } = await import(new URL("../../../packages/cli/node_modules/viem/_esm/index.js", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "vajra-push-"));
const state = join(dir, "state");
mkdirSync(state);
const env = { ...process.env, VAJRA_STATE_DIR: state };
const vajra = (...args) => spawnSync(process.execPath, [main, ...args], { env, encoding: "utf8" });

const key = generatePrivateKey();
const funder = createWalletClient({ account: privateKeyToAccount(readFileSync(join(repo, ".vajra-local/deployer.key"), "utf8").trim()), transport: http(rpcUrl) });
const hash = await funder.sendTransaction({ to: privateKeyToAccount(key).address, value: parseEther("2"), gas: 500_000n, gasPrice: 2_000_000n, type: "legacy", chain: null });
await createPublicClient({ transport: http(rpcUrl) }).waitForTransactionReceipt({ hash });
writeFileSync(join(state, "daily.key"), key, { mode: 0o600 });
const made = vajra("move", "--key-file", join(state, "daily.key"), "--harbor", privateKeyToAccount(generatePrivateKey()).address, "--limit", "0.1", "--allowance", "0.01", "--delay", "900", "--cooling", "30");
if (made.status !== 0) throw new Error(made.stderr);

const service = spawn(process.execPath, [main, "phone", "--port", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
service.stdout.on("data", (d) => (log += d));
for (let i = 0; i < 50 && !(await fetch(`${origin}/api/hello`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));
const pairLink = readFileSync(join(state, "phone-pair.txt"), "utf8").trim();

const profile = join(dir, "profile");
mkdirSync(join(profile, "Default"), { recursive: true });
writeFileSync(join(profile, "Default/Preferences"), JSON.stringify({ brave: { gcm: { channel_status: true } } }));
writeFileSync(join(profile, "Local State"), JSON.stringify({ brave: { gcm: { channel_status: true } } }));
const browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM ?? "/usr/bin/brave-browser", headless: false, args: ["--no-sandbox", "--headless=new"] });
await browser.grantPermissions(["notifications"], { origin });
const page = await browser.newPage();
await page.goto(pairLink);
await page.waitForSelector("#balance");
await page.evaluate(() => navigator.serviceWorker.ready);

let failed = false;
const report = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

console.log("Subscribing through the app's own button. This can take a few minutes.");
await page.click("#push");
await page.waitForSelector("#notice", { timeout: 280_000 });
report((await page.textContent("#notice")) === "Alerts are on.", `the app says: ${await page.textContent("#notice")}`);
const endpoint = JSON.parse(readFileSync(join(state, "phone.json"), "utf8")).subscriptions[0]?.endpoint ?? "";
report(endpoint.startsWith("https://"), `a real push service: ${new URL(endpoint || "http://none").host}`);

const thief = vajra("thief", "0.5");
report(thief.status === 0, "a theft is queued on the mirror");

let shown = null;
for (let i = 0; i < 120 && !shown; i++) {
  await page.waitForTimeout(1000);
  shown = await page.evaluate(async () => {
    const [n] = await (await navigator.serviceWorker.ready).getNotifications();
    return n ? { title: n.title, body: n.body } : null;
  });
}
report(log.includes("alerted: item 0"), "the push service accepted the sender's message");
report(!!shown, shown ? `the notification, through the real push service: ${shown.title}. ${shown.body}` : "no notification arrived in 2 minutes");

await browser.close();
service.kill();
process.exit(failed ? 1 : 0);
