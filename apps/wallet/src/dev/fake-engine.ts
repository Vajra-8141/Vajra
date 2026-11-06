/**
 * An in-memory stand-in for the engine, for screenshots and UI tests only. Nothing here touches a chain, and every hash is random.
 * It is only ever bundled by `node build.mjs --fake`, and the shell says so on every screen.
 *
 * Test hooks: set `window.__fakeFail = "notMe"` to make that call fail once, and `window.__fakeOffline = true` to make snapshot fail.
 * `window.__fakeUnknown = true` makes every chain value in the snapshot unknown.
 */
import type { Address, CreateOptions, Done, Engine, Hash, HistoryItem, Note, OnStep, PrivatePayment, QueuedItem, SendPreview, SendResult, Snapshot } from "../engine-types";

(globalThis as Record<string, unknown>).__VAJRA_FAKE_ENGINE__ = "FAKE_ENGINE_DO_NOT_SHIP";

const KEY = "vajra.fake.v1";
const hooks = globalThis as unknown as { __fakeFail?: string; __fakeOffline?: boolean; __fakeUnknown?: boolean };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const addr = () => `0x${hex(20)}` as Address;
const tx = () => `0x${hex(32)}` as Hash;
const now = () => Math.floor(Date.now() / 1000);
const eth = (n: number) => String(Number(n.toFixed(6)));

interface State {
  passphrase: string;
  account: Address;
  balance: number;
  frozen: boolean;
  escaped: boolean;
  dailyLimit: number;
  spent: number;
  delaySeconds: number;
  queue: QueuedItem[];
  hashKeyLeft: number;
  hashKeyHere: boolean;
  safe: { address: Address; balance: number; keyHeld: boolean };
  recoverySet: boolean;
  exit: { address: Address; reserve: string } | null;
  notes: Note[];
  privatePayments: PrivatePayment[];
  alerts: { telegram: boolean; push: boolean };
  backedUp: boolean;
  history: HistoryItem[];
}

let s: State | null = null;
let open = false;
try {
  const saved = localStorage.getItem(KEY);
  if (saved) s = JSON.parse(saved) as State;
} catch {
  s = null;
}
const save = () => {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* in-memory is enough */
  }
};
const w = (): State => {
  if (!s) throw new Error("No wallet here");
  return s;
};

async function steps(name: string, onStep: OnStep, lines: string[], ms = 420) {
  for (const [i, line] of lines.entries()) {
    onStep(line);
    await sleep(ms);
    if (hooks.__fakeFail === name && i === lines.length - 1) {
      hooks.__fakeFail = undefined;
      throw new Error("execution reverted: the chain did not accept this (fake failure for testing)");
    }
  }
}
function done(refusal: string | null): Done {
  const hash = tx();
  return { hash, block: 48210 + Math.floor(Math.random() * 900), explorer: `https://explorer.invalid/tx/${hash}`, verifyGas: refusal ? 412_880 : null, canonicalRefusal: refusal };
}
const REFUSED = "transaction type not supported";
function log(kind: HistoryItem["kind"], text: string, d?: Done | null) {
  w().history.unshift({ kind, at: now(), text, hash: d?.hash ?? null, explorer: d?.explorer ?? null });
  save();
}
const signedSteps = ["Signing with your hash key", "Sending by the second way in", "Waiting for the block"];
function useHash() {
  const state = w();
  if (!state.hashKeyHere) throw new Error("The hash key is not on this device");
  if (state.hashKeyLeft <= 0) throw new Error("The hash key has no uses left");
  state.hashKeyLeft -= 1;
}
function take(id: string): QueuedItem {
  const state = w();
  const item = state.queue.find((q) => q.id === id);
  if (!item) throw new Error("That payment is no longer waiting");
  state.queue = state.queue.filter((q) => q.id !== id);
  return item;
}

export const engine: Engine = {
  state() {
    return s ? (open ? "open" : "locked") : "empty";
  },
  async create(o: CreateOptions, onStep) {
    await steps("create", onStep, ["Making your wallet key", "Making your hash key, 63 one-time signatures", "Making your safe", "Putting your account on the chain", "Adding test ETH to start with", "Locking it with your passphrase"], 620);
    s = {
      passphrase: o.passphrase,
      account: addr(),
      balance: 0.25,
      frozen: false,
      escaped: false,
      dailyLimit: Number(o.dailyLimit),
      spent: 0,
      delaySeconds: o.delaySeconds,
      queue: [],
      hashKeyLeft: 63,
      hashKeyHere: true,
      safe: { address: o.safe ?? addr(), balance: 0, keyHeld: o.safe === null },
      recoverySet: false,
      exit: null,
      notes: [],
      privatePayments: [{ id: "p1", account: addr(), amount: "0.01", claimed: false }],
      alerts: { telegram: false, push: false },
      backedUp: false,
      history: [],
    };
    open = true;
    log("funded", "Test ETH arrived", done(null));
  },
  async unlock(passphrase) {
    await sleep(500);
    if (passphrase !== w().passphrase) throw new Error("That passphrase doesn't open this wallet");
    open = true;
  },
  lock() {
    open = false;
  },
  async restore(backup, passphrase, onStep) {
    await steps("restore", onStep, ["Reading the file", "Opening it with your passphrase", "Finding your account on the chain"], 500);
    const parsed = JSON.parse(backup) as { fake?: State };
    if (!parsed.fake) throw new Error("That file is not a VAJRA backup");
    if (passphrase !== parsed.fake.passphrase) throw new Error("That passphrase doesn't open this backup");
    s = parsed.fake;
    open = true;
    save();
  },
  async backup() {
    await sleep(350);
    w().backedUp = true;
    save();
    return JSON.stringify({ fake: s, note: "fake backup, for screenshots" });
  },
  forget() {
    s = null;
    open = false;
    save();
  },
  async snapshot(): Promise<Snapshot> {
    await sleep(120);
    if (hooks.__fakeOffline) throw new Error("fetch failed");
    const state = w();
    const unknown = hooks.__fakeUnknown === true;
    return {
      account: state.account,
      balance: unknown ? null : eth(state.balance),
      frozen: unknown ? null : state.frozen,
      escaped: unknown ? null : state.escaped,
      dailyLimit: unknown ? null : eth(state.dailyLimit),
      dailyLeft: unknown ? null : eth(Math.max(0, state.dailyLimit - state.spent)),
      delaySeconds: unknown ? null : state.delaySeconds,
      queue: unknown ? null : state.queue,
      hashKeyLeft: unknown ? null : state.hashKeyLeft,
      hashKeyTotal: 63,
      hashKeyHere: state.hashKeyHere,
      walletKeyHere: true,
      backupStale: false,
      recoveryPending: false,
      safe: { address: state.safe.address, balance: unknown ? null : eth(state.safe.balance), keyHeld: state.safe.keyHeld },
      recoverySet: unknown ? null : state.recoverySet,
      exit: state.exit,
      notes: state.notes,
      privatePayments: state.privatePayments,
      alerts: state.alerts,
      backedUp: state.backedUp,
      history: state.history,
      chainTime: unknown ? null : now(),
    };
  },
  async topUp(onStep) {
    await steps("topUp", onStep, ["Asking the sponsor for test ETH", "Waiting for the block"]);
    w().balance += 0.25;
    log("funded", "Test ETH arrived", done(null));
  },
  async previewSend(_to, amount): Promise<SendPreview> {
    await sleep(160);
    const state = w();
    const n = Number(amount);
    if (state.escaped) return { route: "blocked", reason: "This wallet has escaped. Its money is in your safe." };
    if (state.frozen) return { route: "blocked", reason: "Your wallet is frozen. Unfreeze it first." };
    if (n > state.balance) return { route: "blocked", reason: "That's more than you have." };
    const left = state.dailyLimit - state.spent;
    if (n <= left) return { route: "instant", left: eth(left - n) };
    return { route: "queued", delaySeconds: state.delaySeconds, reason: `That's over the ${eth(left)} ETH you have left today.` };
  },
  async send(to, amount, onStep): Promise<SendResult> {
    const state = w();
    const n = Number(amount);
    const left = state.dailyLimit - state.spent;
    await steps("send", onStep, ["Signing with your wallet key", "Sending", "Waiting for the block"]);
    const d = done(null);
    if (n <= left) {
      state.balance -= n;
      state.spent += n;
      log("sent", `Sent ${amount} ETH`, d);
      return { route: "instant", ...d };
    }
    const id = String(state.history.length + 1);
    const executeAfter = now() + state.delaySeconds;
    state.queue.push({ id, to, amount, executeAfter, isRecovery: false, unknownToThisDevice: false });
    log("queued", `${amount} ETH is waiting in public`, d);
    return { route: "queued", id, executeAfter, ...d };
  },
  async drill(onStep) {
    const state = w();
    const amount = eth(state.dailyLimit * 2);
    await steps("drill", onStep, ["Using your wallet key, as a thief would", `Trying to send ${amount} ETH to a random address`, "Waiting for the block"]);
    const d = done(null);
    const id = `d${state.history.length + 1}`;
    const executeAfter = now() + state.delaySeconds;
    state.queue.push({ id, to: addr(), amount, executeAfter, isRecovery: false, unknownToThisDevice: true });
    log("queued", `${amount} ETH is waiting in public`, d);
    return { route: "queued", id, executeAfter, ...d };
  },
  async notMe(id, onStep) {
    await steps("notMe", onStep, signedSteps);
    const item = take(id);
    useHash();
    const d = done(REFUSED);
    log("cancelled", `Cancelled ${item.amount} ETH with your hash key`, d);
    return d;
  },
  async payNow(id, onStep) {
    await steps("payNow", onStep, signedSteps);
    const item = take(id);
    useHash();
    w().balance -= Number(item.amount);
    const d = done(REFUSED);
    log("paid", `Paid ${item.amount} ETH`, d);
    return d;
  },
  async freeze(onStep) {
    await steps("freeze", onStep, signedSteps);
    useHash();
    w().frozen = true;
    const d = done(REFUSED);
    log("frozen", "Froze your wallet", d);
    return d;
  },
  async unfreeze(onStep) {
    await steps("unfreeze", onStep, signedSteps);
    useHash();
    w().frozen = false;
    const d = done(REFUSED);
    log("unfreeze", "Unfroze your wallet", d);
    return d;
  },
  async escape(onStep) {
    await steps("escape", onStep, [...signedSteps, "Moving everything to your safe"]);
    useHash();
    const state = w();
    state.safe.balance += state.balance;
    state.balance = 0;
    state.escaped = true;
    state.queue = [];
    const d = done(REFUSED);
    log("escaped", "Moved everything to your safe", d);
    return d;
  },
  async rotate(onStep) {
    await steps("rotate", onStep, ["Making a new hash key", ...signedSteps]);
    useHash();
    w().hashKeyLeft = 63;
    const d = done(REFUSED);
    log("rotated", "Replaced your hash key", d);
    return d;
  },
  async setLimit(dailyLimit, onStep) {
    await steps("setLimit", onStep, signedSteps);
    useHash();
    w().dailyLimit = Number(dailyLimit);
    const d = done(REFUSED);
    log("sent", `Daily limit is now ${dailyLimit} ETH`, d);
    return d;
  },
  async finishQueued(id, onStep) {
    await steps("finishQueued", onStep, ["Finishing the payment", "Waiting for the block"]);
    const item = take(id);
    const state = w();
    if (!item.isRecovery) state.balance -= Number(item.amount);
    const d = done(null);
    log(item.isRecovery ? "recovered" : "paid", item.isRecovery ? "Your new key took over" : `Paid ${item.amount} ETH`, d);
    return d;
  },
  async sendFromSafe(to, amount, onStep) {
    const state = w();
    if (Number(amount) > state.safe.balance) throw new Error("insufficient funds in the safe");
    await steps("sendFromSafe", onStep, ["Signing with your safe's key", "Waiting for the block"]);
    state.safe.balance -= Number(amount);
    const d = done(null);
    log("sent", `Sent ${amount} ETH from your safe`, d);
    return { hash: d.hash, explorer: d.explorer };
  },
  async privateCode() {
    await sleep(300);
    return `vajra-${hex(24)}`;
  },
  async sendPrivately(_code, amount, onStep) {
    await steps("sendPrivately", onStep, ["Making a one-time address for them", "Sending", "Waiting for the block"]);
    w().balance -= Number(amount);
    const d = done(null);
    log("private-sent", `Sent ${amount} ETH privately`, d);
    return d;
  },
  async scanPrivate(onStep) {
    await steps("scanPrivate", onStep, ["Looking through recent payments"], 700);
    return w().privatePayments;
  },
  async claimPrivate(id, _to, onStep) {
    await steps("claimPrivate", onStep, ["Claiming", "Waiting for the block"]);
    const state = w();
    const p = state.privatePayments.find((x) => x.id === id);
    if (!p) throw new Error("That payment is gone");
    p.claimed = true;
    state.balance += Number(p.amount);
    const d = done(null);
    log("private-claimed", `Claimed ${p.amount} ETH`, d);
    return d;
  },
  async setupRecovery(_delay, onStep) {
    await steps("setupRecovery", onStep, ["Making your recovery secret", ...signedSteps]);
    useHash();
    w().recoverySet = true;
    const d = done(REFUSED);
    log("recovery-set", "Set up your recovery paper", d);
    return { paper: Array.from({ length: 8 }, () => hex(4)).join(" "), ...d };
  },
  async finishRecovery(onStep) {
    onStep("Finishing");
    return done(null);
  },

  async recover(_paper, account, passphrase, onStep) {
    await steps("recover", onStep, ["Checking your paper", "Proving you hold the paper, without showing it", "Making a new key", "Sending by the second way in"], 600);
    s = {
      passphrase,
      account,
      balance: 0.18,
      frozen: false,
      escaped: false,
      dailyLimit: 0.02,
      spent: 0,
      delaySeconds: 120,
      queue: [{ id: "r1", to: account, amount: "0", executeAfter: now() + 8, isRecovery: true, unknownToThisDevice: false }],
      hashKeyLeft: null as unknown as number,
      hashKeyHere: false,
      safe: { address: addr(), balance: 0, keyHeld: false },
      recoverySet: true,
      exit: null,
      notes: [],
      privatePayments: [],
      alerts: { telegram: false, push: false },
      backedUp: false,
      history: [],
    };
    open = true;
    const d = done(REFUSED);
    onStep("Your old hash key can still cancel this. Waiting");
    await sleep(8000);
    w().queue = [];
    onStep("Installing your new hash key");
    await sleep(500);
    w().hashKeyLeft = 62;
    w().hashKeyHere = true;
    log("recovered", "Recovered this wallet with the paper", d);
    return d;
  },
  async setupExit(onStep) {
    await steps("setupExit", onStep, ["Making a second address", "Funding it with its own money", ...signedSteps]);
    useHash();
    const state = w();
    state.exit = { address: addr(), reserve: "0.01" };
    state.balance -= 0.01;
    const d = done(REFUSED);
    log("exit-set", "Set up your second way out", d);
    return d;
  },
  async exitEscape(onStep) {
    await steps("exitEscape", onStep, ["Signing from your second address", "Moving everything to your safe"]);
    const state = w();
    state.safe.balance += state.balance;
    state.balance = 0;
    state.escaped = true;
    const d = done(null);
    log("escaped", "Moved everything to your safe by the second way out", d);
    return d;
  },
  async shield(onStep) {
    await steps("shield", onStep, ["Making a note only you can open", "Depositing it in the pool", "Waiting for the block"]);
    const state = w();
    state.balance -= 0.01;
    state.notes.push({ id: hex(4), amount: "0.01", payout: "0.0095", spent: false });
    const d = done(null);
    log("shielded", "Shielded 0.01 ETH", d);
    return d;
  },
  async unshield(noteId, _to, onStep) {
    await steps("unshield", onStep, ["Proving this note is yours, without saying which one", "Paying out", "Waiting for the block"], 650);
    const note = w().notes.find((n) => n.id === noteId);
    if (!note) throw new Error("That note is gone");
    note.spent = true;
    const d = done(null);
    log("unshielded", `Paid out ${note.payout} ETH`, d);
    return d;
  },
  async telegramLink() {
    await sleep(200);
    setTimeout(() => {
      if (s) s.alerts.telegram = true;
      save();
    }, 1500);
    return "https://t.me/fake_vajra_bot?start=fake";
  },
  async enablePush() {
    await sleep(500);
    if (hooks.__fakeFail === "enablePush") {
      hooks.__fakeFail = undefined;
      throw new Error("Notification permission denied");
    }
    w().alerts.push = true;
    save();
  },
  async moveHashKeyLink() {
    await sleep(400);
    return `${location.origin}/#/link/${hex(48)}`;
  },
  async confirmMoved() {
    await sleep(300);
    w().hashKeyHere = false;
    save();
  },
  async receiveHashKey(_link, passphrase) {
    await sleep(900);
    if (s) throw new Error("There's already a wallet in this browser.");
    if (passphrase.length < 4) throw new Error("That passphrase doesn't open this link");
    s = {
      passphrase, account: addr(), balance: 0.2, frozen: false, escaped: false, dailyLimit: 0.02, spent: 0, delaySeconds: 120, queue: [], hashKeyLeft: 60, hashKeyHere: true,
      safe: { address: addr(), balance: 0, keyHeld: false }, recoverySet: false, exit: null, notes: [], privatePayments: [], alerts: { telegram: false, push: false }, backedUp: true, history: [],
    };
    open = true;
  },
};
