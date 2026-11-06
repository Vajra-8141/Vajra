/**
 * The extension's service worker: the wallet itself. The daily key lives here, sealed in local storage and open in session storage
 * while unlocked. Session storage is out of reach of content scripts by default, and it goes when the browser closes.
 *
 * Pages of this extension talk to it by message, sites only through a port from the relay. The two never mix: a message is only obeyed
 * if the browser says it came from one of this extension's own pages.
 */
import { type Address, type Hex, getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountState, ops, signDaily } from "@vajra/core/account";
import { DEVNET, RpcError, isLocalStack, rpc } from "@vajra/core/devnet";
import { refusalName, sendAlt, submit, txHash } from "@vajra/core/frame";
import { type Book, removeLabel, setLabel } from "@vajra/shared/addressbook";
import { ProviderError } from "@vajra/shared/request";
import { amountText, forecastSpend } from "@vajra/shared/review";
import { type Approval, type Deps, askAndSend, handle } from "./engine.ts";
import { type Vault, open, seal } from "./vault.ts";

const LOCK_AFTER_MINUTES = 15;

interface Stored {
  account?: Address;
  vault?: Vault;
  sites?: Record<string, true>;
  book?: Book;
  link?: { url: string; token: string };
}

const local = <K extends keyof Stored>(key: K) => chrome.storage.local.get(key).then((found) => (found as Stored)[key]);
const setLocal = (value: Stored) => chrome.storage.local.set(value);
const unlockedKey = () => chrome.storage.session.get("key").then((found) => found.key as Hex | undefined);

async function unlock(password: string) {
  const vault = await local("vault");
  if (!vault) throw new Error("no key here yet");
  await chrome.storage.session.set({ key: await open(vault, password) });
  await chrome.alarms.create("lock", { delayInMinutes: LOCK_AFTER_MINUTES });
}

const lock = () => chrome.storage.session.remove("key");

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "lock") void lock();
});

/** Asks the local service, which is the shared copy, and falls back on the last one seen. */
async function currentBook(): Promise<Book> {
  const link = await local("link");
  if (link) {
    try {
      const response = await fetch(`${link.url}/api/labels`, { headers: { authorization: `Bearer ${link.token}` } });
      if (response.ok) {
        const book = (await response.json()) as Book;
        await setLocal({ book });
        return book;
      }
    } catch {
      // The service is optional, and labels are only notes.
    }
  }
  return (await local("book")) ?? {};
}

async function changeLabel(address: string, label: string) {
  const next = label ? setLabel(await currentBook(), address, label) : removeLabel(await currentBook(), address);
  await setLocal({ book: next });
  const link = await local("link");
  if (link) {
    await fetch(`${link.url}/api/labels`, { method: "POST", headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" }, body: JSON.stringify({ address, label }) }).catch(() => {});
  }
  return next;
}

async function linkService(pairUrl: string) {
  const url = new URL(pairUrl);
  const code = /^#pair=([\w-]+)$/.exec(url.hash)?.[1];
  if (!code) throw new Error("that is not a pairing link");
  const hello = (await (await fetch(`${url.origin}/api/hello`)).json()) as { chainId: number };
  if (hello.chainId !== DEVNET.chainId) throw new Error(`that service is on chain ${hello.chainId}, and this extension on ${DEVNET.chainId}`);
  const response = await fetch(`${url.origin}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, kind: "extension" }) });
  const reply = (await response.json()) as { token?: string; error?: string };
  if (!reply.token) throw new Error(reply.error ?? "pairing failed");
  await setLocal({ link: { url: url.origin, token: reply.token } });
  return { url: url.origin };
}

async function importKey(a: { account: string; key: string; password: string }) {
  if (!isAddress(a.account, { strict: false })) throw new Error("that account is not an address");
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.key)) throw new Error("that is not a private key");
  const account = getAddress(a.account);
  const address = privateKeyToAccount(a.key as Hex).address;
  // A read that fails stops the import: unknown is not a match.
  const { dailyKey } = await accountState(account);
  if (dailyKey !== address) throw new Error(`that key is not this account's daily key, which is ${dailyKey}`);
  await setLocal({ account, vault: await seal(a.key, a.password) });
  await chrome.storage.session.set({ key: a.key });
  await chrome.alarms.create("lock", { delayInMinutes: LOCK_AFTER_MINUTES });
}

// --- approvals: a small window of the extension's own, which a page cannot draw over or reach.

interface Pending {
  request: Approval;
  resolve: (ok: boolean) => void;
  window?: number;
}

const pending = new Map<number, Pending>();
let nextApproval = 1;

function approve(request: Approval): Promise<boolean> {
  return new Promise((resolve) => {
    const id = nextApproval++;
    const entry: Pending = { request, resolve };
    pending.set(id, entry);
    void chrome.windows.create({ url: chrome.runtime.getURL(`approve.html?id=${id}`), type: "popup", width: 400, height: 620 }).then((created) => {
      entry.window = created?.id;
    });
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, entry] of pending) {
    if (entry.window === windowId) {
      pending.delete(id);
      entry.resolve(false);
    }
  }
});

async function answerApproval(a: { id: number; ok: boolean; password?: string }) {
  const entry = pending.get(a.id);
  if (!entry) throw new Error("that request has gone");
  if (a.ok && entry.request.kind === "payment" && !(await unlockedKey())) await unlock(a.password ?? "");
  pending.delete(a.id);
  entry.resolve(a.ok);
  if (entry.window !== undefined) void chrome.windows.remove(entry.window).catch(() => {});
}

// --- sending

async function send(account: Address, payment: { asset: Address; recipient: Address; amount: bigint }): Promise<Hex> {
  const key = await unlockedKey();
  if (!key) throw new ProviderError(4100, "The wallet is locked.");
  const tx = await signDaily({ key, dailyKey: privateKeyToAccount(key).address, account, calls: [ops.spend(payment.asset, payment.recipient, payment.amount)] });
  await sendAlt(tx);
  // The node cancels about one transaction in twenty, and the same bytes have to go again. The storage write keeps this worker awake for that.
  const keepAwake = setInterval(() => void chrome.storage.session.set({ sending: Date.now() }), 10_000);
  void submit(tx)
    .catch((error: Error) => console.log(`not mined: ${error.message}`))
    .finally(() => clearInterval(keepAwake));
  return txHash(tx);
}

const deps: Deps = {
  chainId: DEVNET.chainId,
  account: async () => (await local("account")) ?? null,
  isConnected: async (origin) => (await local("sites"))?.[origin] === true,
  async setConnected(origin, connected) {
    const { [origin]: _, ...rest } = (await local("sites")) ?? {};
    await setLocal({ sites: connected ? { ...rest, [origin]: true } : rest });
  },
  book: currentBook,
  approve,
  forecast: forecastSpend,
  amountText: (payment) => amountText(payment.asset, payment.amount),
  send,
  rpc: (method, params) => rpc(DEVNET.execution, method, params),
  emit(origin, event, payload) {
    for (const port of ports) if (port.sender?.origin === origin) port.postMessage({ event, payload });
  },
};

const ports = new Set<chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  // The approval window holds one of these open, which keeps this worker, and the promise it is waiting on, alive.
  if (port.name === "keepalive") return void port.onMessage.addListener(() => {});
  if (port.name !== "provider" || !port.sender?.origin) return port.disconnect();
  const origin = port.sender.origin;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((message: { id: number; method: string; params?: unknown }) => {
    const params = Array.isArray(message.params) ? message.params : message.params === undefined ? [] : [message.params];
    handle(deps, origin, message.method, params).then(
      (result) => port.postMessage({ id: message.id, result }),
      (error: Error & { code?: number }) => {
        const text = error instanceof RpcError ? refusalName(error.message) : error.message;
        port.postMessage({ id: message.id, error: { code: error.code ?? -32000, message: text } });
      },
    );
  });
});

type Internal = { type: string } & Record<string, unknown>;

async function internal(message: Internal): Promise<unknown> {
  switch (message.type) {
    case "status": {
      const link = await local("link");
      return { account: (await local("account")) ?? null, unlocked: !!(await unlockedKey()), mirror: isLocalStack, chainId: DEVNET.chainId, sites: Object.keys((await local("sites")) ?? {}), linked: link?.url ?? null };
    }
    case "import":
      return importKey(message as never);
    case "unlock":
      return unlock(String(message.password));
    case "lock":
      return lock();
    case "book":
      return currentBook();
    case "label":
      return changeLabel(String(message.address), String(message.label));
    case "link":
      return linkService(String(message.url));
    case "move-plan":
    case "move-done": {
      const link = await local("link");
      if (!link) throw new Error("link the local service first");
      const path = message.type === "move-plan" ? "/api/move/plan" : "/api/move/done";
      const response = await fetch(`${link.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" }, body: JSON.stringify(message.body) });
      const reply = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
      return reply;
    }
    case "disconnect":
      await deps.setConnected(String(message.origin), false);
      deps.emit(String(message.origin), "accountsChanged", []);
      return null;
    case "approval": {
      const entry = pending.get(Number(message.id));
      return entry ? { request: entry.request, locked: !(await unlockedKey()) } : null;
    }
    case "approval-answer":
      return answerApproval(message as never);
    case "pay": {
      const account = await local("account");
      if (!account) throw new Error("no account");
      if (!isAddress(String(message.to), { strict: false })) throw new Error("that is not an address");
      return askAndSend(deps, "this extension", account, { asset: zeroAddress, recipient: getAddress(String(message.to)), amount: parseUnits(String(message.amount), 18) });
    }
  }
  throw new Error(`unknown message ${message.type}`);
}

chrome.runtime.onMessage.addListener((message: Internal, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  internal(message).then(
    (value) => reply({ value }),
    (error: Error) => reply({ error: error instanceof RpcError ? refusalName(error.message) : error.message }),
  );
  return true;
});
