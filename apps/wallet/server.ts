/**
 * The wallet's one small service. It holds no key of anyone's: wallets are made in the browser and only public values reach here.
 *
 * It does what a browser cannot do alone: it pays to create an account and gives it test money, relays a private payment's
 * announcement, finishes a matured recovery (anyone may), and watches accounts to send alerts. If it is down, every key in
 * every wallet still works, straight against the public mempool.
 *
 * Env: SPONSOR_KEY (test money only), TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_NAME, VAPID_PRIVATE, VAPID_PUBLIC, STATE_DIR, PORT, PUBLIC_URL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { type Address, type Hex, formatEther, getAddress, isAddress, isHex, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  LEGACY_GAS_PRICE,
  STEALTH_SCHEME_ID,
  accountV2Abi,
  createAccount,
  createExit,
  deployments,
  predictAccount,
  publicClient,
  readAccount,
  stealthConfig,
  useDeployments,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { type PushSubscription, type Vapid, newVapid, sendPush } from "../../packages/cli/src/webpush.ts";

const PORT = Number(process.env.PORT ?? 8791);
const DIST = new URL("./dist/", import.meta.url).pathname;
const STATE_DIR = process.env.STATE_DIR ?? new URL("../../.vajra-wallet/", import.meta.url).pathname;
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
const KEY = process.env.SPONSOR_KEY as Hex | undefined;
if (!KEY) throw new Error("SPONSOR_KEY is required");
if (process.env.DEPLOYMENTS_FILE) useDeployments(JSON.parse(readFileSync(process.env.DEPLOYMENTS_FILE, "utf8")));
const sponsor = privateKeyToAccount(KEY).address;
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const BOT_NAME = process.env.TELEGRAM_BOT_NAME ?? null;

/** Enough for the stake, a few spends and a pool note. */
const STAKE = parseEther("0.012");
const FUND = parseEther(process.env.FUND ?? "0.03");
const TOP_UP = parseEther("0.015");
const EXIT_RESERVE = parseEther("0.006");
const MAX_TOP_UPS = 2;
const PER_IP_HOUR = Number(process.env.PER_IP_HOUR ?? 6);
/** Below this the service stops giving money away, so the relays keep working. */
const FLOOR = parseEther(process.env.FLOOR ?? "0.03");

interface Watched {
  chats: number[];
  subs: PushSubscription[];
  seen: string[];
  topUps: number;
  exit: boolean;
}
interface State {
  accounts: Record<string, Watched>;
  offset: number;
  vapid: Vapid;
}

mkdirSync(STATE_DIR, { recursive: true });
const statePath = join(STATE_DIR, "wallet-service.json");
const envVapid = process.env.VAPID_PRIVATE && process.env.VAPID_PUBLIC ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE, subject: "mailto:vajra@example.com" } : null;
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { accounts: {}, offset: 0, vapid: envVapid ?? newVapid("mailto:vajra@example.com") };
if (envVapid) state.vapid = envVapid;
const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
save();

const watched = (account: Address): Watched => (state.accounts[account.toLowerCase()] ??= { chats: [], subs: [], seen: [], topUps: 0, exit: false });

/** One transaction at a time from one key: the nonce is the queue. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => {});
  return next;
}

const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_IP_HOUR) return true;
  hits.set(ip, [...recent, now]);
  return false;
}

async function requireFloat(amount: bigint) {
  const balance = await publicClient.getBalance({ address: sponsor });
  if (balance < amount + FLOOR) throw new Refused(503, "The test money for new wallets has run out. Everything else still works.");
}

class Refused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const needAddress = (value: unknown, what: string): Address => {
  if (typeof value !== "string" || !isAddress(value)) throw new Refused(400, `${what} is not an address`);
  return getAddress(value);
};
const needBytes32 = (value: unknown, what: string): Hex => {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) throw new Refused(400, `${what} is not 32 bytes`);
  return value;
};

const announcerAbi = parseAbi(["function announce(uint256,address,bytes,bytes)"]);

const routes: Record<string, (body: Record<string, unknown>, ip: string) => Promise<unknown>> = {
  async "/api/create"(body, ip) {
    if (limited(ip)) throw new Refused(429, "Too many new wallets from here. Try again in an hour.");
    const { v2, genesis } = deployments();
    if (!v2) throw new Refused(503, "This chain has no V2 deployment");
    await requireFloat(FUND);
    const limit = BigInt(String(body.dailyLimit));
    const delay = BigInt(String(body.queueDelay));
    if (limit <= 0n || limit > parseEther("10")) throw new Refused(400, "That daily limit is out of range");
    if (delay < 30n || delay > 604_800n) throw new Refused(400, "That delay is out of range");
    const config = {
      dailyKey: needAddress(body.dailyKey, "dailyKey"),
      wotsRoot: needBytes32(body.wotsRoot, "wotsRoot"),
      epochSalt: genesis,
      harborCommitment: needBytes32(body.harborCommitment, "harborCommitment"),
      queueDelay: delay,
      coolingPeriod: 0n,
      maxDailyTxCost: parseEther("0.01"),
      assets: [ETH],
      dailyLimits: [limit],
      coolingAllowances: [limit],
      stake: STAKE,
      unstakeDelay: 86_400,
    };
    const account = await serial(() => createAccount(KEY!, v2.factory, config, FUND));
    watched(account);
    save();
    return { account, funded: formatEther(FUND - STAKE) };
  },

  async "/api/topup"(body) {
    const account = needAddress(body.account, "account");
    const w = state.accounts[account.toLowerCase()];
    if (!w) throw new Refused(404, "This service did not make that wallet");
    if (w.topUps >= MAX_TOP_UPS) throw new Refused(429, "This wallet has had all its test money.");
    await requireFloat(TOP_UP);
    w.topUps++;
    save();
    const hash = await serial(async () => {
      const sent = await walletFor(KEY!).sendTransaction({ to: account, value: TOP_UP, gas: 300_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never);
      await waitForSuccess(sent, "topping up");
      return sent;
    });
    return { hash, amount: formatEther(TOP_UP), left: MAX_TOP_UPS - w.topUps };
  },

  /** A second sender, with money and a stake of its own. The account's own hash key still has to name it. */
  async "/api/exit"(body) {
    const { v2 } = deployments();
    if (!v2?.exitFactory) throw new Refused(503, "No exit factory on this chain");
    const account = needAddress(body.account, "account");
    const w = state.accounts[account.toLowerCase()];
    if (!w) throw new Refused(404, "This service did not make that wallet");
    if (w.exit) throw new Refused(429, "This wallet already has a second way out");
    await requireFloat(EXIT_RESERVE + STAKE);
    const exit = await serial(() => createExit(KEY!, v2.exitFactory!, account, needBytes32(body.root, "root"), needBytes32(body.epochSalt, "epochSalt"), EXIT_RESERVE, STAKE));
    w.exit = true;
    save();
    return { exit };
  },

  /** Creates a stealth account and publishes the announcement, so the sender's wallet is not the one that does either. */
  async "/api/private"(body) {
    const { w16, genesis, announcer } = deployments();
    const config = stealthConfig(needBytes32(body.root, "root"), needAddress(body.coSigner, "coSigner"), genesis);
    const stealth = await predictAccount(w16.factory, config);
    if (typeof body.ephemeral !== "string" || !isHex(body.ephemeral) || typeof body.viewTag !== "number") throw new Refused(400, "Bad announcement");
    await serial(async () => {
      await createAccount(KEY!, w16.factory, config, 0n);
      const hash = await walletFor(KEY!).writeContract({
        address: announcer,
        abi: announcerAbi,
        functionName: "announce",
        args: [BigInt(STEALTH_SCHEME_ID), stealth, body.ephemeral as Hex, `0x${(body.viewTag as number).toString(16).padStart(2, "0")}`],
        gas: 2_000_000n,
        gasPrice: LEGACY_GAS_PRICE,
        type: "legacy",
        chain: undefined,
      } as never);
      await waitForSuccess(hash, "announcing");
    });
    return { stealth };
  },

  /** Anyone may finish a matured queue item. A wallet on a new device has no money of its own to do it with. */
  async "/api/finish"(body) {
    const account = needAddress(body.account, "account");
    const id = BigInt(String(body.id));
    const hash = await serial(async () => {
      const sent = await walletFor(KEY!).writeContract({ address: account, abi: accountV2Abi as never, functionName: "executeQueued", args: [id], gas: 3_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never);
      await waitForSuccess(sent, "finishing");
      return sent;
    });
    return { hash };
  },

  async "/api/alerts/watch"(body) {
    watched(needAddress(body.account, "account"));
    save();
    return { ok: true };
  },

  async "/api/alerts/push"(body) {
    const w = watched(needAddress(body.account, "account"));
    const sub = body.subscription as PushSubscription;
    if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) throw new Refused(400, "Bad subscription");
    if (!w.subs.some((s) => s.endpoint === sub.endpoint)) w.subs.push(sub);
    save();
    return { ok: true };
  },

  async "/api/alerts/status"(body) {
    const w = state.accounts[needAddress(body.account, "account").toLowerCase()];
    return { telegram: (w?.chats.length ?? 0) > 0, push: (w?.subs.length ?? 0) > 0 };
  },
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".zkey": "application/octet-stream",
  ".json": "application/json",
};

function serveFile(url: string, res: ServerResponse) {
  const path = normalize(decodeURIComponent(url.split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
  const file = join(DIST, path === "/" ? "index.html" : path);
  if (!file.startsWith(DIST) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": /\.(html|js|webmanifest)$/.test(file) ? "no-cache" : "public, max-age=3600", "x-content-type-options": "nosniff" });
  res.end(readFileSync(file));
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 16_384) reject(new Refused(413, "Too big"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  try {
    if (url === "/api/config") {
      return json(200, { sponsor, telegramBot: BOT && BOT_NAME ? BOT_NAME : null, vapidPublic: state.vapid.publicKey, chainId: DEVNET.chainId, deployments: deployments(), explorer: DEVNET.explorer });
    }
    if (url === "/api/health") return json(200, { ok: true, sponsorBalance: formatEther(await publicClient.getBalance({ address: sponsor })) });
    const route = routes[url.split("?")[0]!];
    if (route) {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim();
      return json(200, await route(JSON.parse((await readBody(req)) || "{}"), ip));
    }
    return serveFile(url, res);
  } catch (error) {
    const known = error instanceof Refused;
    if (!known) console.error(url, (error as Error).message);
    json(known ? (error as Refused).status : 500, { error: known ? (error as Error).message : "Something went wrong on the service. Try again." });
  }
});

/** Alerts carry no secret and can do nothing: the button only opens the app, where the person decides. */
async function telegram(method: string, body: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await response.json()) as { ok: boolean; result?: never };
}

async function pollTelegram() {
  for (;;) {
    try {
      const reply = (await telegram("getUpdates", { offset: state.offset, timeout: 25 })) as { ok: boolean; result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };
      for (const update of reply.result ?? []) {
        state.offset = update.update_id + 1;
        const match = update.message?.text?.match(/^\/start\s+(0x)?([0-9a-fA-F]{40})$/);
        if (!match || !update.message) continue;
        const w = watched(`0x${match[2]}` as Address);
        if (!w.chats.includes(update.message.chat.id)) w.chats.push(update.message.chat.id);
        await telegram("sendMessage", { chat_id: update.message.chat.id, text: "You're linked. If a payment over your limit is ever queued, I'll tell you here within seconds." });
      }
      save();
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function notify(account: Address, w: Watched, id: string, text: string) {
  const open = `${PUBLIC_URL}/#/queue`;
  for (const chat of w.chats) {
    await telegram("sendMessage", { chat_id: chat, text, reply_markup: { inline_keyboard: [[{ text: "Open VAJRA", url: open }]] } }).catch(() => {});
  }
  const live: PushSubscription[] = [];
  for (const sub of w.subs) {
    const result = await sendPush(state.vapid, sub, { title: "Was this you?", body: text, id }).catch(() => ({ failed: "" }) as const);
    if (result !== "gone") live.push(sub);
  }
  w.subs = live;
}

async function watchLoop() {
  for (;;) {
    for (const [address, w] of Object.entries(state.accounts)) {
      if (w.chats.length === 0 && w.subs.length === 0) continue;
      try {
        const view = await readAccount(address as Address);
        for (const item of view.items) {
          const id = item.id.toString();
          if (item.state !== 1 || w.seen.includes(id)) continue;
          w.seen.push(id);
          save();
          await notify(address as Address, w, id, `${formatEther(item.amount)} ETH is waiting to leave your wallet, to ${item.recipient.slice(0, 8)}…${item.recipient.slice(-4)}. If this wasn't you, tap Not me before the countdown ends.`);
        }
      } catch {
        // A failed read is retried on the next pass: the seen list only moves after a real view.
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

server.listen(PORT, () => console.log(`wallet service on ${PORT}, sponsor ${sponsor}, telegram ${BOT && BOT_NAME ? "on" : "off"}`));
void watchLoop();
if (BOT) void pollTelegram();
