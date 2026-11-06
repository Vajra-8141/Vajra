// The phone app in a real browser, against the real service, on the mirror. Real here: the PWA, the service worker, WebAuthn through
// Chromium's virtual authenticator, the chain and every transaction. Stand-ins: the push service and Telegram's servers, both local.
// The push message is encrypted and signed for real, decrypted by the stand-in, then handed to the real worker over CDP.
//
//   VAJRA_LANE=2 VAJRA_STACK=local node apps/phone/test/e2e.mjs
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv, createECDH, createHash, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

if (process.env.VAJRA_STACK !== "local") throw new Error("run this on the mirror, with VAJRA_STACK=local");
const repo = new URL("../../../", import.meta.url).pathname;
const main = join(repo, "packages/cli/src/main.ts");
const lane = Number(process.env.VAJRA_LANE ?? 0);
const rpcUrl = `http://127.0.0.1:${18545 + lane * 100}`;
const PORT = 3210 + lane * 100;
const PUSH_PORT = 8910 + lane * 100;
const TELEGRAM_PORT = 8911 + lane * 100;
const origin = `http://localhost:${PORT}`;
const OWNER = 42;

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, test, ms = 45_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(300);
  }
  check(false, `timed out: ${what}`);
  return false;
}

const rpc = async (method, params) => (await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const balanceOf = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));

// --- an account of its own, made by the real move
const dir = mkdtempSync(join(tmpdir(), "vajra-phone-"));
const state = join(dir, "state");
mkdirSync(state);
const env = { ...process.env, VAJRA_PHONE_PORT: String(PORT), VAJRA_STATE_DIR: state, TELEGRAM_API: `http://127.0.0.1:${TELEGRAM_PORT}`, TELEGRAM_BOT_TOKEN: "test", TELEGRAM_CHAT_ID: String(OWNER) };
const vajra = (...args) => spawnSync(process.execPath, [main, ...args], { env, encoding: "utf8" });

const { generatePrivateKey, privateKeyToAccount } = await import(new URL("../../../packages/cli/node_modules/viem/_esm/accounts/index.js", import.meta.url));
const { createWalletClient, http, parseEther, formatEther } = await import(new URL("../../../packages/cli/node_modules/viem/_esm/index.js", import.meta.url));
const key = generatePrivateKey();
const eoa = privateKeyToAccount(key);
const deployerKey = readFileSync(join(repo, ".vajra-local/deployer.key"), "utf8").trim();
const funder = createWalletClient({ account: privateKeyToAccount(deployerKey), transport: http(rpcUrl) });
await funder.sendTransaction({ to: eoa.address, value: parseEther("3"), gas: 500_000n, gasPrice: 2_000_000n, type: "legacy", chain: null });
await until("the EOA to be funded", async () => (await balanceOf(eoa.address)) > 0n);
writeFileSync(join(state, "daily.key"), key, { mode: 0o600 });
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const made = vajra("move", "--key-file", join(state, "daily.key"), "--harbor", harbor, "--limit", "0.1", "--allowance", "0.01", "--delay", "900", "--cooling", "30");
if (made.status !== 0) throw new Error(made.stderr);
const { account } = JSON.parse(readFileSync(join(state, "wallet.json"), "utf8"));
const seed = JSON.parse(readFileSync(join(state, "signer.json"), "utf8")).seed;
console.log(`account ${account}`);

// --- stand-in push service: it checks what a real one checks, and decrypts as the phone would
const receiver = createECDH("prime256v1");
receiver.generateKeys();
const authSecret = randomBytes(16);
const pushed = [];
function decrypt(body) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const as = body.subarray(21, 21 + idLength);
  const cipher = body.subarray(21 + idLength);
  const ua = receiver.getPublicKey();
  const ikm = Buffer.from(hkdfSync("sha256", receiver.computeSecret(as), authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(cipher.subarray(-16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}
function vapidValid(header) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header ?? "");
  if (!match) return false;
  const [head, claims, signature] = match[1].split(".");
  const point = Buffer.from(match[2], "base64url");
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
  const { aud, exp } = JSON.parse(Buffer.from(claims, "base64url"));
  return aud === `http://127.0.0.1:${PUSH_PORT}` && exp > Date.now() / 1000 && verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
}
const pushServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (!vapidValid(req.headers.authorization) || req.headers["content-encoding"] !== "aes128gcm") return (res.writeHead(401), res.end());
    pushed.push({ cipher: body, text: decrypt(body) });
    res.writeHead(201);
    res.end();
  });
}).listen(PUSH_PORT, "127.0.0.1");

// --- stand-in Telegram, the pattern from watch-e2e.ts
const telegramSent = [];
let telegramQueue = [];
let nextUpdate = 1;
const telegramServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const method = req.url.split("/").pop();
    const reply = (result) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ ok: true, result })));
    if (method === "sendMessage") return telegramSent.push(body.text), reply({});
    if (method === "answerCallbackQuery") return reply(true);
    const updates = telegramQueue;
    telegramQueue = [];
    reply(updates);
  });
}).listen(TELEGRAM_PORT, "127.0.0.1");
const tap = (data) => telegramQueue.push({ update_id: nextUpdate++, callback_query: { id: "q", from: { id: OWNER }, data } });

// --- the service
const children = new Set();
function start(args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [main, ...args], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  child.log = "";
  child.stdout.on("data", (d) => (child.log += d));
  child.stderr.on("data", (d) => (child.log += d));
  children.add(child);
  return child;
}
const stop = async (child) => {
  child.kill();
  children.delete(child);
  await sleep(300);
};
const serviceUp = () => until("the service", () => fetch(`${origin}/api/hello`).then((r) => r.ok, () => false), 15_000);

let service = start(["phone"]);
await serviceUp();
const pairLink = readFileSync(join(state, "phone-pair.txt"), "utf8").trim();
check(!service.log.includes(pairLink.split("#pair=")[1]), "the pairing code is not printed");

// --- the browser
const browser = await chromium.launchPersistentContext(join(dir, "profile"), {
  executablePath: process.env.CHROMIUM ?? "/usr/bin/brave-browser",
  headless: false,
  args: ["--no-sandbox", "--headless=new"],
  viewport: { width: 390, height: 800 },
});
await browser.grantPermissions(["notifications"], { origin });
const page = await browser.newPage();
const seen = [];
page.on("response", (r) => r.url().includes("/api/") && r.text().then((t) => seen.push(t), () => {}));
const cdp = await browser.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

console.log("\n1. A service with no pairing answers nobody");
const open = await fetch(`${origin}/api/state`);
check(open.status === 401, "no token: refused");
const hostile = await fetch(`${origin}/api/state`, { headers: { origin: "https://evil.example" } });
check(hostile.status === 403, "another site's origin: refused");
const rebound = await new Promise((resolve) => {
  import("node:http").then(({ request }) => {
    const r = request({ host: "127.0.0.1", port: PORT, path: "/api/hello", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode));
    r.end();
  });
});
check(rebound === 403, "a rebound DNS name: refused");

console.log("\n2. It pairs from the link, and it installs");
await page.goto(pairLink);
await page.waitForSelector("#balance");
check(!page.url().includes("pair="), "the code left the address bar");
const token = await page.evaluate(() => localStorage.getItem("vajra.token"));
check(typeof token === "string" && token.length > 30, "the phone holds a pairing token");
check(/ETH/.test(await page.textContent("#balance")), `balance: ${await page.textContent("#balance")}`);
check(/ETH/.test(await page.textContent("#left")), `limit left: ${await page.textContent("#left")}`);
check((await page.textContent("#mirror")).includes("Local mirror"), "it says it is the mirror");
await page.evaluate(() => navigator.serviceWorker.ready);
check(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), "the service worker is active");
const { errors } = await cdp.send("Page.getInstallabilityErrors").then((r) => ({ errors: r.installabilityErrors }));
check(errors.length === 0, `installable, by Chromium's own check: ${JSON.stringify(errors)}`);
const manifest = await cdp.send("Page.getAppManifest");
check(manifest.errors.length === 0 && manifest.url.endsWith("manifest.webmanifest"), "the manifest parses with no errors");
const used = await fetch(`${origin}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairLink.split("#pair=")[1], kind: "phone" }) });
check(used.status === 403, "the code works once");

const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const post = (path, body) => fetch(`${origin}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });

console.log("\n3. Alerts: what real browsers do here");
await page.click("#push");
await page.waitForSelector("#notice");
const pushNote = await page.textContent("#notice");
console.log(`  this browser says: ${pushNote}`);
const reallySubscribed = pushNote === "Alerts are on.";
check(reallySubscribed || pushNote.includes("Telegram is the backup"), "a push service failure is said plainly, and points to the backup");
await post("/api/push/subscribe", { endpoint: `http://127.0.0.1:${PUSH_PORT}/sub/1`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } });
check((await post("/api/push/subscribe", { endpoint: "http://192.168.1.5/x", keys: { p256dh: "a", auth: "b" } })).status === 400, "a push endpoint on the network over http is refused");

console.log("\n4. A passkey is set, and labelled for what it is");
await page.click("#passkey");
await page.waitForFunction(() => document.querySelector("#passkey")?.textContent === "Passkey is set");
check((await page.textContent("main")).includes("does not change the contracts"), "the screen says the contracts do not know");

console.log("\n5. A theft reaches the phone, decoded");
const thief = vajra("thief", "0.5");
if (thief.status !== 0) console.log(thief.stderr);
const thiefTo = /sends 0\.5 ETH to (0x[0-9a-fA-F]{40})/.exec(thief.stdout)[1];
await until("the push", () => pushed.length === 1);
check(pushed[0]?.text.includes("0.5 ETH"), `decrypted by the stand-in: ${pushed[0]?.text}`);
check(!pushed[0]?.cipher.includes(Buffer.from("0.5 ETH")), "the push service saw only ciphertext");
await page.waitForSelector('[data-item="0"]');

console.log("\n6. The real worker shows it, and a tap opens the review");
const registration = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.scope));
const swTarget = await browser.newCDPSession(page);
await swTarget.send("ServiceWorker.enable");
const version = await new Promise((resolve) => swTarget.on("ServiceWorker.workerRegistrationUpdated", (e) => e.registrations.length && resolve(e.registrations[0])));
await swTarget.send("ServiceWorker.deliverPushMessage", { origin, registrationId: version.registrationId, data: pushed[0].text });
const shown = await until("the notification", () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length > 0), 10_000);
check(shown, `the worker for ${registration} put up a notification`);
const notification = await page.evaluate(async () => {
  const [n] = await (await navigator.serviceWorker.ready).getNotifications();
  return { title: n.title, body: n.body, tag: n.tag };
});
check(notification.title === "A payment is waiting" && notification.body.includes("0.5 ETH"), `it reads: ${notification.body}`);

await page.click('[data-item="0"]');
await page.waitForSelector("#not-me");
check((await page.textContent("#amount")) === "0.5 ETH", "the amount");
check((await page.textContent("#recipient")).toLowerCase() === thiefTo.toLowerCase(), "the full address");
check((await page.textContent("#payee")) === "No label", "no label");
check((await page.textContent("#reason")).includes("new"), `why: ${await page.textContent("#reason")}`);
check((await page.textContent('[data-warning="danger"]')).includes("First time"), "a first-seen warning, even though the queued spend itself recorded the payee");

console.log("\n7. Pay is off on a software signer, by the same rule as Telegram");
check(await page.isDisabled("#pay"), "the button is off");
check((await page.textContent("#pay-note")).includes("hardware signer"), "and says why");
const refusedPay = await post("/api/answer", { action: "pay", id: "0" });
check(refusedPay.status === 403 && (await refusedPay.json()).error.includes("hardware signer"), "the service refuses it even if the page is bypassed");

console.log("\n8. Not me: the hash key cancels it");
await page.click("#not-me");
await until("the cancel", async () => (await page.textContent("#outcome").catch(() => "")).includes("Signed by the hash key"), 60_000);
check((await page.textContent("#outcome")).startsWith("Cancelled"), await page.textContent("#outcome"));
const second = await post("/api/answer", { action: "veto", id: "0" });
check(second.status === 403, "a second tap does nothing");
await stop(service);

console.log("\n9. Pay needs the passkey, and a verified user");
service = start(["phone", "--allow-software-pay"]);
await serviceUp();
await page.goto(`${origin}/`);
await page.waitForSelector("#balance");
const before = vajra("thief", "0.5");
const payee = /sends 0\.5 ETH to (0x[0-9a-fA-F]{40})/.exec(before.stdout)[1];
await page.waitForSelector('[data-item="1"]');
await page.click('[data-item="1"]');
await page.waitForSelector("#pay:not([disabled])");
check((await page.textContent("#pay-note")).includes("contracts do not know"), "Pay is labelled as a client-side check");
const noPasskey = await post("/api/answer", { action: "pay", id: "1" });
check(noPasskey.status === 403 && (await noPasskey.json()).error.includes("expired"), "Pay with no passkey answer: refused");
const noAssertion = await post("/api/passkey/challenge", { id: "1" });
check(noAssertion.ok, "a challenge is issued for this item");
const forged = await post("/api/answer", { action: "pay", id: "1", assertion: { id: "x", clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" } });
check(forged.status === 403 && (await forged.json()).error.includes("Passkey refused"), "a made-up assertion: refused");
check((await balanceOf(payee)) === 0n, "nothing has moved");

await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
await page.click("#pay");
await until("the refusal", async () => (await page.textContent("#outcome").catch(() => "")).length > 60 || !(await page.textContent("#outcome").catch(() => "")).includes("Checking"), 30_000);
const unverified = await page.textContent("#outcome");
check(!unverified.startsWith("Paid"), `no user verification: ${unverified.slice(0, 80)}`);
check((await balanceOf(payee)) === 0n, "still nothing has moved");

await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
await page.click("#pay");
await until("the payment", async () => (await page.textContent("#outcome").catch(() => "")).startsWith("Paid"), 60_000);
check((await balanceOf(payee)) === parseEther("0.5"), `the recipient holds ${formatEther(await balanceOf(payee))} ETH, before the timer`);

console.log("\n10. The address book changes what the phone says");
await page.goto(`${origin}/`);
await page.waitForSelector("#balance");
const friend = privateKeyToAccount(generatePrivateKey()).address;
await post("/api/labels", { address: friend, label: "Asha" });
check((await post("/api/labels", { address: friend, label: "0xdeadbeefdeadbeef" })).status === 400, "a label cannot pose as an address");
vajra("spend", friend, "0.5");
await page.waitForSelector('[data-item="2"]');
await page.click('[data-item="2"]');
await page.waitForSelector("#not-me");
check((await page.textContent("#payee")) === "Asha", "the label is shown");
check((await page.textContent("#headline")).includes("Asha"), `the headline uses it: ${await page.textContent("#headline")}`);
check((await page.locator('[data-warning="danger"]').count()) === 0, "a labelled address gets no first-seen warning");
await page.fill("#label", "Asha rent");
await page.click("#save-label");
await until("the new label", async () => (await page.textContent("#payee").catch(() => "")) === "Asha rent", 8000);
check(true, "a label can be changed from the review screen");

console.log("\n11. Telegram is the backup, and both can sign at once without sharing a leaf");
const watcher = start(["watch", "--allow-software-pay"]);
await until("the Telegram alert", () => telegramSent.some((text) => text.includes("0.5 ETH")));
vajra("thief", "0.5");
await page.goto(`${origin}/`);
await page.waitForSelector('[data-item="3"]');
const leavesBefore = Object.keys(JSON.parse(readFileSync(join(state, "signer.json"), "utf8")).revealed).length;
tap("veto:2");
const phoneVeto = await post("/api/answer", { action: "veto", id: "3" });
check(phoneVeto.ok, "the phone's cancel landed");
await until("Telegram's cancel", () => telegramSent.some((text) => text.startsWith("Cancelled item 2")), 60_000);
const signer = JSON.parse(readFileSync(join(state, "signer.json"), "utf8"));
check(Object.keys(signer.revealed).length === leavesBefore + 2, "two operations, two different leaves");

await stop(service);
vajra("thief", "0.5");
await until("the alert with the service down", () => telegramSent.filter((text) => text.includes("0.5 ETH")).length >= 3);
tap("veto:4");
await until("Telegram alone", () => telegramSent.some((text) => text.startsWith("Cancelled item 4")), 60_000);
check(telegramSent.some((text) => text.startsWith("Cancelled item 4")), "with the phone service down, Telegram still cancels");
await stop(watcher);

console.log("\n12. Unknown is never zero");
await until("the page to say so", async () => (await page.textContent("main")).includes("unknown"), 10_000);
check(!/0(\.0+)? ETH/.test(await page.textContent("main")), "a dead service: unknown on screen, and no zero");
service = start(["phone"], { VAJRA_LANE: "9" });
await serviceUp();
await page.goto(`${origin}/`);
await page.waitForSelector("#unknown");
check((await page.textContent("#balance")) === "unknown" && (await page.textContent("#left")) === "unknown", "a dead chain: balance and limit are unknown");
check(await page.isVisible("#queue-unknown"), "and the queue is unknown, not empty");
check((await page.locator("#empty").count()) === 0, "it does not say nothing is waiting");
await stop(service);

console.log("\n13. The phone never held the master key");
const storage = await page.evaluate(async () => {
  const cached = [];
  for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) cached.push(request.url);
  return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cached });
});
const bare = seed.slice(2);
check(!storage.includes(bare), "not in storage or the cache");
check(!seen.some((text) => text.includes(bare)), `not in any of ${seen.length} API replies`);
check(!storage.includes("/api/"), "no API reply was cached");
const bundle = readFileSync(join(repo, "apps/phone/dist/app.js"), "utf8");
check(!/wotsSign|signMasterTx|MasterSigner/.test(bundle), "the app has no signing code in it");
const onDisk = readFileSync(join(state, "phone.json"), "utf8");
check(!onDisk.includes(token), "the service keeps a hash of the token, not the token");
check(existsSync(join(state, "vapid.json")), "the VAPID key is generated and kept locally");

await browser.close();
pushServer.close();
telegramServer.close();
for (const child of children) child.kill();
console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
