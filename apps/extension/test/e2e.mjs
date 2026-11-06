// The extension loaded in a real browser, against the real service, on the mirror. It needs a browser that loads extensions: the
// Playwright headless shell does not, so this runs Brave in new headless mode. Every transaction here is real. Nothing is stood in for.
//
//   VAJRA_STACK=local VAJRA_LANE=2 pnpm --filter @vajra/extension build
//   VAJRA_LANE=2 VAJRA_STACK=local node apps/extension/test/e2e.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, parseAbi, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

if (process.env.VAJRA_STACK !== "local") throw new Error("run this on the mirror, with VAJRA_STACK=local");
const repo = new URL("../../../", import.meta.url).pathname;
const main = join(repo, "packages/cli/src/main.ts");
const lane = Number(process.env.VAJRA_LANE ?? 0);
const rpcUrl = `http://127.0.0.1:${18545 + lane * 100}`;
const USDC = "0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5";
const PORT = 3211;
const DAPP = 8920;
const origin = `http://localhost:${PORT}`;
const extensionPath = join(repo, "apps/extension/dist");

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

const chain = createPublicClient({ transport: http(rpcUrl) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const accountAbi = parseAbi(["function dailyKey() view returns (address)", "function nextItem() view returns (uint256)", "function queuedItem(uint256) view returns ((address recipient, address asset, uint256 amount, uint64 executeAfter, uint8 state))"]);
const tokens = (who) => chain.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [who] });
const nextItem = (account) => chain.readContract({ address: account, abi: accountAbi, functionName: "nextItem" });

// --- a wallet with money in it, on the mirror
const key = generatePrivateKey();
const eoa = privateKeyToAccount(key).address;
const funder = createWalletClient({ account: privateKeyToAccount(readFileSync(join(repo, ".vajra-local/deployer.key"), "utf8").trim()), transport: http(rpcUrl) });
const legacy = { gas: 500_000n, gasPrice: 2_000_000n, type: "legacy", chain: null };
await chain.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: eoa, value: parseEther("3"), ...legacy }) });
await chain.waitForTransactionReceipt({ hash: await funder.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [eoa, 9_000_000n], ...legacy }) });

// --- the service, in a folder with no account yet
const dir = mkdtempSync(join(tmpdir(), "vajra-ext-"));
const state = join(dir, "state");
mkdirSync(state);
const service = spawn(process.execPath, [main, "phone", "--port", String(PORT)], { env: { ...process.env, VAJRA_STATE_DIR: state }, stdio: "ignore" });
await until("the service", () => fetch(`${origin}/api/hello`).then((r) => r.ok, () => false), 15_000);
const pairLink = readFileSync(join(state, "phone-pair.txt"), "utf8").trim();

// --- a small dapp, on two origins
const dappServer = createServer((_, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><title>dapp</title><h1>dapp</h1>");
}).listen(DAPP, "127.0.0.1");

const browser = await chromium.launchPersistentContext(join(dir, "profile"), {
  executablePath: process.env.CHROMIUM ?? "/usr/bin/brave-browser",
  headless: false,
  args: ["--no-sandbox", "--headless=new", `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;
const page = (name) => `chrome-extension://${extensionId}/${name}`;
console.log(`loaded in a real browser, extension ${extensionId}`);

const dapp = await browser.newPage();
await dapp.goto(`http://127.0.0.1:${DAPP}/`);
const request = (method, params, where = dapp) =>
  where.evaluate(
    ([m, p]) => window.ethereum.request({ method: m, params: p }).then((result) => ({ result }), (error) => ({ code: error.code, message: error.message })),
    [method, params],
  );

/** Starts a request, and hands back the approval window it opens with the request's own promise. */
async function withApproval(method, params) {
  const opening = browser.waitForEvent("page", { predicate: (p) => p.url().includes("approve.html"), timeout: 20_000 });
  const answer = request(method, params);
  const window = await opening;
  await window.waitForSelector("#approve");
  return { window, answer };
}

console.log("\n1. A dapp finds it");
// Brave's own wallet announces too, so this is the case EIP-6963 exists for: a dapp picks a wallet by name.
const announced = await dapp.evaluate(async () => {
  const seen = [];
  window.addEventListener("eip6963:announceProvider", (event) => seen.push(event.detail));
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const mine = seen.find((detail) => detail.info.rdns === "io.github.vajra-8141");
  return { all: seen.map((detail) => detail.info.name), info: mine && { ...mine.info }, chainId: await mine?.provider.request({ method: "eth_chainId" }) };
});
console.log(`  announced here: ${announced.all.join(", ")}`);
check(announced.info?.name === "VAJRA", "EIP-6963: VAJRA announces itself");
check(announced.chainId === toHex(13370), "and a dapp that picks it by rdns reaches the wallet through that provider");
check(/^[0-9a-f-]{36}$/.test(announced.info?.uuid) && announced.info?.icon.startsWith("data:image/"), "with a uuid and a data icon, as the EIP asks");
check((await request("eth_chainId")).result === toHex(13370), "eth_chainId through the provider");
check((await request("eth_accounts")).result.length === 0, "eth_accounts is empty before connecting");
check((await request("eth_requestAccounts")).code === 4100, "no account yet: 4100");

console.log("\n2. Move a wallet in, from the extension's own page");
const move = await browser.newPage();
await move.goto(page("move.html"));
await move.fill("#pair", pairLink);
await move.fill("#key", key);
const harbor = privateKeyToAccount(generatePrivateKey()).address;
await move.fill("#harbor", harbor);
await move.fill("#tokens", USDC);
await move.fill("#delay", "900");
await move.fill("#cooling", "30");
await move.fill("#password", "correct horse");
await move.click("#plan");
await move.waitForSelector("#go:not([hidden])", { timeout: 20_000 }).catch(async () => console.log(`  status: ${await move.textContent("#status")}`));
check((await move.textContent("#plan-from")).includes(eoa), "the summary names the wallet");
check((await move.textContent(`[data-token="${USDC}"]`)).startsWith("9000000"), "and the tokens");
const account = /To (0x[0-9a-fA-F]{40})/.exec(await move.textContent("#plan-to"))[1];
await move.click("#go");
await move.waitForSelector('#status[data-done="true"]', { timeout: 60_000 }).catch(async () => console.log(`  status: ${await move.textContent("#status")}`));
const done = await move.textContent("#status");
const moveHash = /0x[0-9a-f]{64}/.exec(done)?.[0];
const receipt = await chain.request({ method: "eth_getTransactionReceipt", params: [moveHash] });
check(receipt?.frameReceipts?.length === 3 && receipt.frameReceipts.every((f) => f.status === "0x1"), "one transaction, three frames, all succeeded");
check((await tokens(account)) === 9_000_000n && (await tokens(eoa)) === 0n, "the tokens moved");
check((await chain.getBalance({ address: eoa })) < parseEther("0.01"), `the wallet keeps only the gas refund: ${formatEther(await chain.getBalance({ address: eoa }))}`);
check((await chain.readContract({ address: account, abi: accountAbi, functionName: "dailyKey" })) === eoa, "and is now the daily key");
check(JSON.parse(readFileSync(join(state, "wallet.json"), "utf8")).account === account, "the service kept the master key's wallet");
await move.close();

console.log("\n3. Connecting takes the owner's yes");
const refused = await withApproval("eth_requestAccounts");
check((await refused.window.textContent("#origin")) === `http://127.0.0.1:${DAPP}`, "the window names the site, from the browser and not the page");
await refused.window.click("#reject");
check((await refused.answer).code === 4001, "refused: 4001");
const yes = await withApproval("eth_requestAccounts");
await yes.window.click("#approve");
check((await yes.answer).result?.[0] === account, "connected: the dapp sees the VAJRA account, not the wallet");
check((await request("eth_accounts")).result[0] === account, "eth_accounts now answers");
const otherSite = await browser.newPage();
await otherSite.goto(`http://localhost:${DAPP}/`);
check((await request("eth_accounts", [], otherSite)).result.length === 0, "another origin sees nothing");
const sneak = await request("eth_sendTransaction", [{ to: harbor, value: "0x1" }], otherSite);
check(sneak.code === 4100, "and cannot ask for a payment");
await otherSite.close();

console.log("\n4. The popup, and reads through the provider");
const popup = await browser.newPage();
const openPopup = async () => {
  await popup.goto(page("popup.html"));
  await popup.waitForSelector("#balance");
};
await openPopup();
const onChain = await chain.getBalance({ address: account });
check((await request("eth_getBalance", [account, "latest"])).result === toHex(onChain), "eth_getBalance matches the chain");
check((await popup.textContent("#balance")) === `${formatEther(onChain)} ETH`, `popup balance: ${await popup.textContent("#balance")}`);
check((await popup.textContent("#left")) === "0.1 ETH", `limit left: ${await popup.textContent("#left")}`);
check((await popup.textContent("#mirror")).includes("Local mirror"), "it says it is the mirror");
check(await popup.isVisible("#queue-empty"), "the queue is read as empty");

console.log("\n5. A small payment: warned, decoded, signed, mined");
const shop = privateKeyToAccount(generatePrivateKey()).address;
const small = await withApproval("eth_sendTransaction", [{ from: account, to: shop, value: toHex(parseEther("0.005")) }]);
check((await small.window.textContent("#amount")) === "Pay 0.005 ETH", "the amount");
check((await small.window.textContent("#recipient")) === shop, "the full address");
check((await small.window.textContent('[data-warning="first-seen"]')).includes("First time"), "a first-seen warning");
check((await small.window.getAttribute("#forecast", "data-outcome")) === "leaves", `forecast: ${await small.window.textContent("#forecast")}`);
await small.window.click("#approve");
const paid = await small.answer;
check(/^0x[0-9a-f]{64}$/.test(paid.result ?? ""), `a hash back: ${paid.result ?? paid.message}`);
await until("the payment", async () => (await chain.getBalance({ address: shop })) === parseEther("0.005"));
check((await chain.getBalance({ address: shop })) === parseEther("0.005"), "the recipient has it");
const seen = await request("eth_getTransactionReceipt", [paid.result]);
check(seen.result?.status === "0x1", "the dapp can read the receipt through the provider");
await openPopup();
check((await popup.textContent("#left")) === "0.095 ETH", `limit left fell: ${await popup.textContent("#left")}`);

console.log("\n6. A big payment waits in public, and the popup shows it");
const stranger = privateKeyToAccount(generatePrivateKey()).address;
const big = await withApproval("eth_sendTransaction", [{ to: stranger, value: toHex(parseEther("0.5")) }]);
check((await big.window.getAttribute("#forecast", "data-outcome")) === "queues", `forecast: ${await big.window.textContent("#forecast")}`);
await big.window.click("#approve");
check(!!(await big.answer).result, "signed");
await until("the queue", async () => (await nextItem(account)) === 1n);
check((await chain.getBalance({ address: stranger })) === 0n, "no money left");
await openPopup();
await popup.waitForSelector('[data-item="0"]');
check((await popup.textContent('[data-item="0"]')).includes("0.5 ETH"), `popup queue: ${(await popup.textContent('[data-item="0"]')).slice(0, 70)}`);

console.log("\n7. A token transfer becomes a spend of that token");
const transfer = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [stranger, 2_000_000n] });
const token = await withApproval("eth_sendTransaction", [{ to: USDC, data: transfer }]);
check((await token.window.textContent("#recipient")) === stranger, "the recipient is decoded from the calldata, not the token's address");
check((await token.window.getAttribute("#forecast", "data-outcome")) === "queues", "a token with a limit of zero queues");
await token.window.click("#approve");
await token.answer;
await until("the token item", async () => (await nextItem(account)) === 2n);
const item = await chain.readContract({ address: account, abi: accountAbi, functionName: "queuedItem", args: [1n] });
check(item.asset === USDC && item.amount === 2_000_000n && item.recipient === stranger, "queued on chain as that token");

console.log("\n8. What the daily key must not do is refused here, with the reason");
const swap = await request("eth_sendTransaction", [{ to: USDC, data: "0x095ea7b3" + "00".repeat(64) }]);
check(swap.code === 4200 && swap.message.includes("master key"), `a contract call: ${swap.code}`);
check((await request("eth_sendTransaction", [{ data: "0x60" }])).code === 4200, "a deployment: 4200");
check((await request("personal_sign", ["0x1234", account])).code === 4200, "personal_sign: 4200");
check((await request("eth_signTypedData_v4", [account, "{}"])).code === 4200, "typed data: 4200");
check((await request("eth_sendRawTransaction", ["0x00"])).code === 4200, "a raw transaction: 4200");
check((await request("wallet_switchEthereumChain", [{ chainId: "0x1" }])).code === 4902, "another chain: 4902");
const no = await withApproval("eth_sendTransaction", [{ to: shop, value: "0x1" }]);
await no.window.click("#reject");
check((await no.answer).code === 4001, "a refused payment: 4001");

console.log("\n9. A label from the popup reaches the approval window and the service");
await openPopup();
await popup.fill("#label-address", shop);
await popup.fill("#label-name", "Corner shop");
await popup.click("#save-label");
await popup.waitForSelector(`[data-label="${shop.toLowerCase()}"]`);
check(JSON.parse(readFileSync(join(state, "addressbook.json"), "utf8"))[shop.toLowerCase()]?.label === "Corner shop", "the service has it, for the phone");
const labelled = await withApproval("eth_sendTransaction", [{ to: shop, value: toHex(parseEther("0.001")) }]);
check((await labelled.window.textContent("#payee")) === "Corner shop", "the approval shows the label");
check((await labelled.window.locator("[data-warning]").count()) === 0, "and no warning");
await labelled.window.click("#reject");
await labelled.answer;

console.log("\n10. The popup's own Pay goes through the same review");
await openPopup();
await popup.fill("#to", shop);
await popup.fill("#amount", "0.002");
const before = await chain.getBalance({ address: shop });
const fromPopup = browser.waitForEvent("page", { predicate: (p) => p.url().includes("approve.html"), timeout: 20_000 });
await popup.click("#pay");
const popupWindow = await fromPopup;
await popupWindow.waitForSelector("#approve");
check((await popupWindow.textContent("#origin")) === "Asked by this extension", "the approval window opens for it too");
check((await popupWindow.textContent("#payee")) === "Corner shop", "with the label");
await popupWindow.click("#approve");
await until("the popup's payment", async () => (await chain.getBalance({ address: shop })) === before + parseEther("0.002"));
check((await chain.getBalance({ address: shop })) === before + parseEther("0.002"), "the payment from the popup was mined");

console.log("\n11. Locked, a payment needs the password");
await openPopup();
await popup.click("#lock");
await popup.waitForSelector("#unlock");
const locked = await withApproval("eth_sendTransaction", [{ to: shop, value: toHex(parseEther("0.001")) }]);
await locked.window.fill("#password", "not the password");
await locked.window.click("#approve");
await locked.window.waitForFunction(() => document.querySelector("#error")?.textContent === "wrong password");
check(true, "a wrong password: said so, and the window stays");
await locked.window.fill("#password", "correct horse");
await locked.window.click("#approve");
check(!!(await locked.answer).result, "the right one: signed");

console.log("\n12. Unknown is never zero");
await popup.route(`${rpcUrl}/**`, (route) => route.abort());
await popup.route(rpcUrl, (route) => route.abort());
await popup.goto(page("popup.html"));
await popup.waitForSelector("#read-failed");
check((await popup.textContent("#balance")) === "unknown" && (await popup.textContent("#left")) === "unknown", "a dead node: balance and limit say unknown");
check(await popup.isVisible("#queue-unknown"), "the queue says unknown, not empty");
await popup.unroute(rpcUrl);
await popup.unroute(`${rpcUrl}/**`);

console.log("\n13. Where the keys are");
const stored = await worker.evaluate(async () => ({ local: JSON.stringify(await chrome.storage.local.get(null)), session: JSON.stringify(await chrome.storage.session.get(null)) }));
const bare = key.slice(2);
check(!stored.local.includes(bare), "the daily key is sealed in local storage");
const signerFile = JSON.parse(readFileSync(join(state, "signer.json"), "utf8"));
check(!stored.local.includes(signerFile.seed.slice(2)) && !stored.session.includes(signerFile.seed.slice(2)), "the master seed is not in the extension");
const serviceFiles = readdirSync(state).map((name) => readFileSync(join(state, name), "utf8")).join();
check(!serviceFiles.includes(bare), "the wallet's key never reached the service");

console.log("\n14. Importing an existing account checks the key against the chain");
const second = await chromium.launchPersistentContext(join(dir, "profile2"), {
  executablePath: process.env.CHROMIUM ?? "/usr/bin/brave-browser",
  headless: false,
  args: ["--no-sandbox", "--headless=new", `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const worker2 = second.serviceWorkers()[0] ?? (await second.waitForEvent("serviceworker"));
const setup = await second.newPage();
await setup.goto(`chrome-extension://${new URL(worker2.url()).host}/popup.html`);
await setup.waitForSelector("#import");
await setup.fill("#import-account", account);
await setup.fill("#import-key", generatePrivateKey());
await setup.fill("#import-password", "correct horse");
await setup.click("#import");
await sleep(1500);
check((await setup.locator("#balance").count()) === 0, "a key that is not the daily key is refused");
await setup.fill("#import-account", account);
await setup.fill("#import-key", key);
await setup.fill("#import-password", "correct horse");
await setup.click("#import");
await setup.waitForSelector("#balance");
check(/ETH/.test(await setup.textContent("#balance")), "the daily key is accepted");
await second.close();

await browser.close();
dappServer.close();
service.kill();
console.log(`\n${failures} failures`);
process.exit(failures ? 1 : 0);
