// Another wallet owns window.ethereum and MetaMask only announces itself, as in Brave or with several wallets installed.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.addInitScript(() => {
  window.__asked = [];
  const wallet = (name) => ({ request: async ({ method }) => (window.__asked.push(`${name}:${method}`), ["0x7C37D70846c44deb6710749B5b539e90DB93135D"]) });
  window.ethereum = wallet("other");
  const detail = Object.freeze({ info: { rdns: "io.metamask", name: "MetaMask", uuid: "1", icon: "" }, provider: wallet("metamask") });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
});
await page.goto(`${process.env.BASE ?? "http://localhost:3000"}/account`);
const button = page.getByRole("button", { name: "Connect wallet" }).first();
await button.waitFor({ timeout: 60_000 });
await button.click();
await page.waitForTimeout(1000);
const asked = await page.evaluate(() => window.__asked);
console.log(asked);
await browser.close();
process.exit(asked.join() === "metamask:eth_requestAccounts" ? 0 : 1);
