/**
 * The wallet itself. Keys are made here, stay here, and sign here; the chain is reached directly, through the public alt mempool.
 * The service in server.ts only ever sees public values. See engine-types.ts for what the screens may ask.
 */
import { type Address, type Hex, bytesToHex, formatEther, hexToBytes, parseAbiItem, parseEther, concat, keccak256, numberToHex, pad, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  type FrameTx,
  LEGACY_GAS_PRICE,
  MasterSigner,
  ROTATION_LEAF,
  RpcError,
  STEALTH_SCHEME_ID,
  type SignerState,
  type SignerStore,
  TREE_LEAVES,
  WOTS_W16,
  accountState,
  accountV2Abi,
  createPayment,
  decodeMeta,
  deployments,
  exitTicket,
  framesSucceeded,
  harborCommitment,
  leafNonceKey,
  openAnnouncement,
  ops,
  opsV2,
  predictAccount,
  publicClient,
  queuedEvents,
  readAccount,
  recoveryGate,
  recoveryTicket,
  recoveryTx,
  refusalName,
  refusalNameV2,
  releaseCalls,
  rpcBatch,
  signDaily,
  signExitTx,
  signMasterTx,
  signStealthSpend,
  simulate,
  sleep,
  stealthCoSigner,
  stealthConfig,
  stealthKeygen,
  stealthSecretKey,
  stealthWotsSeed,
  submit,
  unshieldTx,
  useDeployments,
  waitForSuccess,
  walletFor,
  type Call,
  type Deployments,
  type FrameReceipt,
} from "@vajra/core";
import type { Done, Engine, HistoryItem, Hash, Note, OnStep, PrivatePayment, QueuedItem, SendPreview, SendResult, Snapshot } from "./engine-types.ts";
import { FIELD, newNote, noteCommitment, proveRecovery, proveUnshield, randomFieldElement, recoveryCommitment } from "./engine/prove.ts";
import { type Sealed, decode, encode, newSalt, open, seal, stretch } from "./engine/vault.ts";

const MAX_HASHES = 520;
const DRILL_OVER = "0.001";
const STORE = "vajra.wallet.v1";
const MIN_PASSPHRASE = 8;
/** The chain's base fee is a few wei. The library default of 2 gwei is paid in full as a tip, which would eat a test wallet. */
const FEES = { maxFeePerGas: 20_000_000n };

/** What the blob holds. `seed` is null once the hash key has moved to a phone; `dailyKey` is null on that phone. */
interface Secrets {
  account: Address;
  dailyKey: Hex | null;
  seed: Hex | null;
  nextSeed: Hex | null;
  safe: Address;
  safeKey: Hex | null;
  harborSalt: Hex;
  stealthSeed: Hex | null;
  exit: { address: Address; seed: Hex } | null;
  notes: { id: string; secret: string; nullifierSeed: string; commitment: string; leaf: number; spent: boolean }[];
  privates: { account: Address; ss: Hex; claimed: boolean; signer: SignerState | null }[];
  scannedTo: string;
  backedUp: boolean;
  /** Queue items this device asked for on purpose. */
  mine: string[];
}

interface Stored {
  sealed: Sealed;
  /** Public: shown on the lock screen. */
  account: Address;
}

const kv = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => localStorage.setItem(key, value),
  del: (key: string) => localStorage.removeItem(key),
};

let session: { secrets: Secrets; key: CryptoKey; salt: Uint8Array } | null = null;
let trees = new Map<string, MasterSigner>();
let configReady: Promise<ServiceConfig> | null = null;

interface ServiceConfig {
  sponsor: Address;
  telegramBot: string | null;
  vapidPublic: string;
  chainId: number;
  deployments: Deployments;
  explorer: string;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
    throw new Error("Can't reach the VAJRA service. Your keys are safe; check your connection and try again.");
  });
  const reply = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(reply.error ?? "The VAJRA service couldn't do that. Try again.");
  return reply;
}

const apiBase = () => (globalThis as unknown as { VAJRA_API?: string }).VAJRA_API ?? "";

function config(): Promise<ServiceConfig> {
  configReady ??= api<ServiceConfig>("/api/config").then((c) => {
    useDeployments(c.deployments);
    return c;
  });
  configReady.catch(() => (configReady = null));
  return configReady;
}

const explorerTx = (hash: string) => `${DEVNET.explorer}/tx/${hash}`;
const need = () => {
  if (!session) throw new Error("Unlock your wallet first.");
  return session;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function persist() {
  const s = need();
  const stored: Stored = { sealed: await seal(s.key, s.salt, s.secrets), account: s.secrets.account };
  kv.set(STORE, JSON.stringify(stored));
}

const stored = (): Stored | null => {
  const text = kv.get(STORE);
  return text ? (JSON.parse(text) as Stored) : null;
};

/** The use record of one tree, outside the blob, written before any signature leaves. */
function leafStore(seed: Hex): SignerStore {
  const id = `vajra.leaves.${keccak256(seed).slice(2, 18)}`;
  return {
    load() {
      const saved = kv.get(id);
      const { nextLeaf, revealed } = saved ? (JSON.parse(saved) as Pick<SignerState, "nextLeaf" | "revealed">) : { nextLeaf: 0, revealed: {} };
      return { seed, nextLeaf, revealed };
    },
    save: (state) => kv.set(id, JSON.stringify({ nextLeaf: state.nextLeaf, revealed: state.revealed })),
  };
}

function treeOf(seed: Hex): MasterSigner {
  let tree = trees.get(seed);
  if (!tree) {
    tree = new MasterSigner(WOTS_W16, leafStore(seed), () => hexToBytes(seed));
    trees.set(seed, tree);
  }
  return tree;
}

const NONCE_MANAGER: Address = "0x0000000000000000000000000000000000008250";
const nonceSlot = (account: Address, key: bigint) => keccak256(concat([pad(account, { size: 32 }), numberToHex(key, { size: 32 })]));

/**
 * A backup, or a key moved from another device, can be behind. The chain knows every use, so skip past them.
 * A one-time signature used twice would let anyone forge a third, and a failed read here stops the signature.
 */
async function catchUpLeaves(seed: Hex, sender: Address): Promise<MasterSigner> {
  const tree = treeOf(seed);
  const leaves = Array.from({ length: TREE_LEAVES }, (_, leaf) => leaf);
  const values = await rpcBatch<Hex>(
    DEVNET.execution,
    leaves.map((leaf) => ({ method: "eth_getStorageAt", params: [NONCE_MANAGER, nonceSlot(sender, leafNonceKey(tree.root, leaf)), "latest"] })),
  );
  const used = leaves.filter((leaf) => BigInt(values[leaf]!) !== 0n && leaf !== ROTATION_LEAF);
  const store = leafStore(seed);
  const state = store.load()!;
  const next = used.length ? Math.max(...used) + 1 : 0;
  if (next > state.nextLeaf) {
    store.save({ ...state, nextLeaf: next });
    trees.delete(seed);
    return treeOf(seed);
  }
  return tree;
}

const plainRefusal = (message: string) => {
  const name = refusalNameV2(message) || refusalName(message);
  const words: Record<string, string> = {
    AccountFrozen: "Your wallet is frozen. Unfreeze it with the hash key first.",
    BadMasterSignature: "The chain didn't accept that hash key signature.",
    HarborMismatch: "That safe address doesn't match the one set when this wallet was made.",
    QueuedPendingTimelock: "The countdown isn't over yet.",
    RootUnknown: "The private pool moved on. Try again.",
    NullifierSpent: "This has already been used.",
  };
  return words[name] ?? null;
};

function plain(error: unknown): Error {
  if (error instanceof RpcError) return new Error(plainRefusal(error.message) ?? `The network refused this: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

/** The normal mempool's own reason, or null when it would have taken this, or when nobody could say. */
async function normalMempoolWould(tx: FrameTx): Promise<string | null> {
  const verdict = await simulate(tx).catch(() => null);
  const canonical = verdict?.canonical;
  if (!canonical || canonical.admitted !== false) return null;
  return canonical.reason ?? canonical.rule ?? canonical.refusal;
}

async function land(tx: FrameTx, onStep: OnStep, wait = "Waiting for the next block"): Promise<Done & { receipt: FrameReceipt }> {
  const canonicalRefusal = await normalMempoolWould(tx);
  onStep(canonicalRefusal ? "Sending through the alt mempool, because the normal one would refuse this" : "Sending through the alt mempool");
  const { hash, receipt } = await submit(tx, { log: () => onStep(wait) }).catch((error) => {
    throw plain(error);
  });
  if (!framesSucceeded(receipt)) throw new Error(plainRefusal("") ?? "The transaction was mined, but one of its steps failed. Nothing was moved.");
  return {
    hash: hash as Hash,
    block: Number(BigInt(receipt.blockNumber)),
    explorer: explorerTx(hash),
    verifyGas: receipt.frameReceipts[0] ? Number(BigInt(receipt.frameReceipts[0].gasUsed)) : null,
    canonicalRefusal,
    receipt,
  };
}

const finished = ({ receipt: _receipt, ...done }: Done & { receipt: FrameReceipt }): Done => done;

function needHashKey(): Hex {
  const { seed } = need().secrets;
  if (!seed) throw new Error("Your hash key is on your phone. Do this there.");
  return seed;
}

/** One hash key action. The leaf is recorded by the signer before the signature exists. */
async function master(calls: Call[], onStep: OnStep): Promise<Done & { receipt: FrameReceipt }> {
  await config();
  const { account } = need().secrets;
  onStep("Getting your hash key ready");
  await tick();
  const signer = await catchUpLeaves(needHashKey(), account);
  const state = await accountState(account);
  if (state.wotsRoot.toLowerCase() !== signer.root.toLowerCase()) throw new Error("The chain has a different hash key for this wallet. If you recovered it elsewhere, use that device.");
  if (signer.leavesLeft === 0) throw new Error("This hash key is used up. Replace it first.");
  onStep("Signing with your hash key");
  await tick();
  const { tx } = signMasterTx({ signer, account, epochSalt: state.epochSalt, calls, maxHashes: MAX_HASHES, fees: FEES });
  return land(tx, onStep);
}

async function daily(calls: Call[], onStep: OnStep) {
  await config();
  const { account, dailyKey } = need().secrets;
  if (!dailyKey) throw new Error("This device only holds the hash key. Spend from your other device.");
  onStep("Signing with your wallet key");
  const address = privateKeyToAccount(dailyKey).address;
  const tx = await signDaily({ key: dailyKey, dailyKey: address, account, calls, fees: FEES });
  return land(tx, onStep);
}

const historyKey = () => `vajra.history.${need().secrets.account.toLowerCase()}`;
const history = (): HistoryItem[] => JSON.parse(kv.get(historyKey()) ?? "[]") as HistoryItem[];
function record(kind: HistoryItem["kind"], text: string, hash: string | null) {
  kv.set(historyKey(), JSON.stringify([{ kind, at: Date.now(), text, hash, explorer: hash ? explorerTx(hash) : null }, ...history()].slice(0, 100)));
}

const eth = (wei: bigint) => formatEther(wei);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const read = <T>(address: Address, functionName: string, args: unknown[] = []) => publicClient.readContract({ address, abi: accountV2Abi as never, functionName, args } as never) as Promise<T>;
const orNull = <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);

async function sendCore(to: Address, amount: string, onStep: OnStep, intended: boolean): Promise<SendResult> {
  const done = await daily([ops.spend(ETH, to, parseEther(amount))], onStep);
  const logs = done.receipt.frameReceipts.flatMap((f) => f.logs) as { topics: Hex[]; data: Hex }[];
  const [queued] = queuedEvents(logs);
  if (!queued) {
    record("sent", `Sent ${amount} ETH to ${short(to)}`, done.hash);
    return { route: "instant", ...finished(done) };
  }
  const id = queued.id.toString();
  if (intended) {
    need().secrets.mine.push(id);
    await persist();
  }
  record("queued", `${amount} ETH to ${short(to)} is waiting in public`, done.hash);
  return { route: "queued", id, executeAfter: Number(queued.executeAfter), ...finished(done) };
}

async function queueOf(account: Address, items: Awaited<ReturnType<typeof readAccount>>["items"]): Promise<QueuedItem[]> {
  const waiting = items.filter((item) => item.state === 1);
  const mine = need().secrets.mine;
  return Promise.all(
    waiting.map(async (item) => ({
      id: item.id.toString(),
      to: item.recipient,
      amount: eth(item.amount),
      executeAfter: Number(item.executeAfter),
      isRecovery: await read<boolean>(account, "isRecovery", [item.id]),
      unknownToThisDevice: !mine.includes(item.id.toString()),
    })),
  );
}

async function poolLeaves(account: Address): Promise<bigint[]> {
  const event = parseAbiItem("event Shielded(uint256 indexed commitment, uint256 leaf, uint256 root)");
  const logs = await publicClient.getLogs({ address: account, event, fromBlock: 0n, toBlock: "latest" });
  const leaves: bigint[] = [];
  for (const log of logs) {
    if (Number(log.args.leaf) !== leaves.length) throw new Error("The pool's history has a gap, so this can't be proved right now.");
    leaves.push(log.args.commitment!);
  }
  return leaves;
}

/** Each wallet's stealth keys come from 128 random bytes, which the keygen checks are valid scalars. */
function newStealthSeed(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(128)));
}

const stealthKeys = () => {
  const s = need().secrets;
  if (!s.stealthSeed) throw new Error("Private payments live on your main device.");
  return stealthKeygen(hexToBytes(s.stealthSeed));
};

const paperOf = (secret: bigint) => numberToHex(secret, { size: 32 }).slice(2).match(/.{1,4}/g)!.join("-");
function secretOfPaper(paper: string): bigint {
  const clean = paper.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length !== 64) throw new Error("That isn't a whole recovery paper. It should be 64 letters and numbers.");
  const secret = BigInt(`0x${clean}`);
  if (secret <= 0n || secret >= FIELD) throw new Error("That isn't a recovery paper.");
  return secret;
}

async function openNewSession(secrets: Secrets, passphrase: string) {
  const salt = newSalt();
  session = { secrets, key: await stretch(passphrase, salt), salt };
  trees = new Map();
  await persist();
}

function requirePassphrase(passphrase: string) {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`);
}

export const engine: Engine = {
  state() {
    if (session) return "open";
    return stored() ? "locked" : "empty";
  },

  async create(o, onStep) {
    requirePassphrase(o.passphrase);
    if (stored()) throw new Error("There's already a wallet in this browser.");
    await config();
    onStep("Making your wallet key");
    const dailyKey = generatePrivateKey();
    onStep("Making your hash key: 64 one-time signatures");
    await tick();
    const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const root = treeOf(seed).root;
    const safeKey = o.safe ? null : generatePrivateKey();
    const safe = o.safe ?? privateKeyToAccount(safeKey!).address;
    const harborSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    onStep("Creating your wallet on the chain");
    const { account } = await api<{ account: Address; funded: string }>("/api/create", {
      dailyKey: privateKeyToAccount(dailyKey).address,
      wotsRoot: root,
      harborCommitment: harborCommitment(safe, harborSalt),
      dailyLimit: parseEther(o.dailyLimit).toString(),
      queueDelay: o.delaySeconds,
    });
    await openNewSession(
      { account, dailyKey, seed, nextSeed: null, safe, safeKey, harborSalt, stealthSeed: newStealthSeed(), exit: null, notes: [], privates: [], scannedTo: "0", backedUp: false, mine: [] },
      o.passphrase,
    );
    record("funded", "Wallet created, with test ETH from the sponsor", null);
    onStep("Your wallet is ready");
  },

  async unlock(passphrase) {
    const saved = stored();
    if (!saved) throw new Error("There's no wallet in this browser.");
    const { value, key, salt } = await open<Secrets>(saved.sealed, passphrase);
    session = { secrets: value, key, salt };
    await config();
  },

  lock() {
    session = null;
    trees = new Map();
  },

  async restore(backup, passphrase, onStep) {
    onStep("Opening the backup");
    const sealed = JSON.parse(backup) as Sealed;
    if (sealed.vajra !== "wallet") throw new Error("That isn't a VAJRA backup file.");
    const { value, key, salt } = await open<Secrets>(sealed, passphrase);
    await config();
    session = { secrets: value, key, salt };
    trees = new Map();
    if (value.seed) {
      onStep("Checking the chain for what this key already signed");
      await tick();
      const signer = await catchUpLeaves(value.seed, value.account);
      const state = await accountState(value.account);
      if (state.wotsRoot.toLowerCase() !== signer.root.toLowerCase()) {
        session = null;
        throw new Error("This backup is older than your wallet's current hash key. Use a newer backup, or your recovery paper.");
      }
    }
    await persist();
    onStep("Your wallet is back");
  },

  async backup() {
    const s = need();
    s.secrets.backedUp = true;
    await persist();
    return JSON.stringify(stored()!.sealed);
  },

  forget() {
    kv.del(STORE);
    session = null;
    trees = new Map();
  },

  async snapshot() {
    await config();
    const s = need().secrets;
    const account = s.account;
    const seed = s.seed;
    const [view, delay, gate, exitAddress, safeBalance, block, alerts, escaped] = await Promise.all([
      orNull(readAccount(account)),
      orNull(read<bigint>(account, "queueDelay")),
      orNull(read<Hex>(account, "recoveryGate")),
      s.exit ? orNull(publicClient.getBalance({ address: s.exit.address })) : Promise.resolve(null),
      orNull(publicClient.getBalance({ address: s.safe })),
      orNull(publicClient.getBlock()),
      orNull(api<{ telegram: boolean; push: boolean }>("/api/alerts/status", { account })),
      orNull(read<boolean>(account, "poolClosed")),
    ]);
    const queue = view ? await orNull(queueOf(account, view.items)) : null;
    const denomination = BigInt(deployments().v2?.denomination ?? 0);
    const fee = BigInt(deployments().v2?.noteFee ?? 0);
    const notes: Note[] = s.notes.map((n) => ({ id: n.id, amount: eth(denomination), payout: eth(denomination - fee), spent: n.spent }));
    const privatePayments: PrivatePayment[] = await Promise.all(
      s.privates.map(async (p) => ({ id: p.account, account: p.account, amount: eth((await orNull(publicClient.getBalance({ address: p.account }))) ?? 0n), claimed: p.claimed })),
    );
    const left = view ? (view.limit > view.spent ? view.limit - view.spent : 0n) : null;
    const leavesLeft = seed ? Math.max(0, ROTATION_LEAF - (leafStore(seed).load()?.nextLeaf ?? 0)) : null;
    const snapshot: Snapshot = {
      account,
      balance: view ? eth(view.balance) : null,
      frozen: view?.frozen ?? null,
      escaped,
      dailyLimit: view ? eth(view.limit) : null,
      dailyLeft: left === null ? null : eth(left),
      delaySeconds: delay === null ? null : Number(delay),
      queue,
      hashKeyLeft: leavesLeft,
      hashKeyTotal: ROTATION_LEAF,
      hashKeyHere: seed !== null,
      safe: { address: s.safe, balance: safeBalance === null ? null : eth(safeBalance), keyHeld: s.safeKey !== null },
      recoverySet: gate === null ? null : gate !== zeroHash,
      exit: s.exit ? { address: s.exit.address, reserve: exitAddress === null ? null : eth(exitAddress) } : null,
      notes,
      privatePayments,
      alerts: alerts ?? { telegram: false, push: false },
      backedUp: s.backedUp,
      history: history(),
      chainTime: block ? Number(block.timestamp) : null,
    };
    return snapshot;
  },

  async topUp(onStep) {
    onStep("Asking the sponsor for test ETH");
    const { hash, amount } = await api<{ hash: Hash; amount: string }>("/api/topup", { account: need().secrets.account });
    record("funded", `Got ${amount} test ETH`, hash);
  },

  async previewSend(to, amount): Promise<SendPreview> {
    const { account } = need().secrets;
    const view = await readAccount(account);
    const wei = parseEther(amount);
    if (view.frozen) return { route: "blocked", reason: "Your wallet is frozen. Unfreeze it to spend." };
    if (wei <= 0n) return { route: "blocked", reason: "Enter an amount above zero." };
    if (to.toLowerCase() === account.toLowerCase()) return { route: "blocked", reason: "That's this wallet's own address." };
    if (wei > view.balance) return { route: "blocked", reason: `You only have ${eth(view.balance)} ETH.` };
    const left = view.limit > view.spent ? view.limit - view.spent : 0n;
    if (wei <= left) return { route: "instant", left: eth(left - wei) };
    const delay = await read<bigint>(account, "queueDelay");
    return { route: "queued", delaySeconds: Number(delay), reason: `That's over the ${eth(left)} ETH you have left today.` };
  },

  send: (to, amount, onStep) => sendCore(to, amount, onStep, true),

  async drill(onStep) {
    await config();
    const view = await readAccount(need().secrets.account);
    const left = view.limit > view.spent ? view.limit - view.spent : 0n;
    const thief = privateKeyToAccount(generatePrivateKey()).address;
    const amount = eth(left + parseEther(DRILL_OVER));
    onStep(`Playing the thief: your wallet key tries to take ${amount} ETH`);
    return sendCore(thief, amount, onStep, false);
  },

  async notMe(id, onStep) {
    const done = await master([ops.veto(BigInt(id))], onStep);
    record("cancelled", "Cancelled a waiting payment with the hash key", done.hash);
    return finished(done);
  },

  async payNow(id, onStep) {
    await config();
    const { account } = need().secrets;
    const item = await read<{ recipient: Address; asset: Address; amount: bigint; state: number }>(account, "queuedItem", [BigInt(id)]);
    if (item.state !== 1) throw new Error("That payment isn't waiting any more.");
    if (await read<boolean>(account, "isRecovery", [BigInt(id)])) throw new Error("That's a key recovery, not a payment.");
    const done = await master(releaseCalls({ id: BigInt(id), recipient: item.recipient, asset: item.asset, amount: item.amount }), onStep);
    record("paid", `Paid ${eth(item.amount)} ETH early with the hash key`, done.hash);
    return finished(done);
  },

  async freeze(onStep) {
    const done = await master([ops.freeze()], onStep);
    record("frozen", "Froze the wallet", done.hash);
    return finished(done);
  },

  async unfreeze(onStep) {
    const done = await master([ops.unfreeze()], onStep);
    record("unfreeze", "Unfroze the wallet", done.hash);
    return finished(done);
  },

  async escape(onStep) {
    const { safe, harborSalt } = need().secrets;
    const done = await master([ops.escape(safe, harborSalt)], onStep);
    record("escaped", `Moved everything to your safe, ${short(safe)}`, done.hash);
    return finished(done);
  },

  async rotate(onStep) {
    const s = need();
    needHashKey();
    onStep("Making a new hash key");
    await tick();
    const nextSeed = s.secrets.nextSeed ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    s.secrets.nextSeed = nextSeed;
    await persist();
    const done = await master([ops.rotateRoot(treeOf(nextSeed).root)], onStep);
    s.secrets.seed = nextSeed;
    s.secrets.nextSeed = null;
    s.secrets.backedUp = false;
    await persist();
    record("rotated", "Replaced the hash key. Save a new backup.", done.hash);
    return finished(done);
  },

  async setLimit(dailyLimit, onStep) {
    const wei = parseEther(dailyLimit);
    const done = await master([ops.setRule(ETH, wei, wei)], onStep);
    record("sent", `Daily limit is now ${dailyLimit} ETH`, done.hash);
    return finished(done);
  },

  async finishQueued(id, onStep) {
    const done = await daily([ops.executeQueued(BigInt(id))], onStep);
    record("paid", "A waiting payment went through", done.hash);
    return finished(done);
  },

  async sendFromSafe(to, amount, onStep) {
    const { safeKey } = need().secrets;
    if (!safeKey) throw new Error("You own this safe yourself. Use the wallet that holds its key.");
    onStep("Sending from your safe");
    const hash = await walletFor(safeKey).sendTransaction({ to, value: parseEther(amount), gas: 300_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never);
    await waitForSuccess(hash, "sending from the safe");
    record("sent", `Sent ${amount} ETH from your safe to ${short(to)}`, hash);
    return { hash, explorer: explorerTx(hash) };
  },

  async privateCode() {
    const { meta } = stealthKeys();
    return bytesToHex(meta).slice(2);
  },

  async sendPrivately(code, amount, onStep) {
    await config();
    const clean = code.trim().replace(/^.*\/pay\//, "").replace(/^0x/, "");
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== 2500) throw new Error("That isn't a private payment code.");
    const { account } = need().secrets;
    const view = await readAccount(account);
    const left = view.limit > view.spent ? view.limit - view.spent : 0n;
    if (parseEther(amount) > left) throw new Error(`Private payments must fit in today's limit. You have ${eth(left)} ETH left.`);
    const meta = decodeMeta(hexToBytes(`0x${clean}`));
    onStep("Making a one-time address only they can open");
    await tick();
    const payment = createPayment(meta);
    const signer = new MasterSigner(WOTS_W16, { load: () => undefined, save: () => {} }, () => stealthWotsSeed(payment.ss));
    const coSigner = stealthCoSigner(meta.spendingPk, payment.ss);
    onStep("Announcing it without your wallet's name on it");
    const { stealth } = await api<{ stealth: Address }>("/api/private", { root: signer.root, coSigner, ephemeral: bytesToHex(payment.ephemeral), viewTag: payment.viewTag });
    const done = await daily([ops.spend(ETH, stealth, parseEther(amount))], onStep);
    record("private-sent", `Sent ${amount} ETH privately`, done.hash);
    return finished(done);
  },

  async scanPrivate(onStep) {
    await config();
    const s = need().secrets;
    const keys = stealthKeys();
    const { w16, genesis, announcer } = deployments();
    onStep("Looking through public announcements");
    const head = await publicClient.getBlockNumber();
    const event = parseAbiItem("event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)");
    const logs = await publicClient.getLogs({ address: announcer, event, args: { schemeId: BigInt(STEALTH_SCHEME_ID) }, fromBlock: BigInt(s.scannedTo), toBlock: head });
    for (const log of logs) {
      let ss: Uint8Array | null = null;
      try {
        ss = openAnnouncement(keys, hexToBytes(log.args.ephemeralPubKey!), hexToBytes(log.args.metadata!));
      } catch {
        continue;
      }
      if (!ss || s.privates.some((p) => p.account === log.args.stealthAddress)) continue;
      onStep("Found one that might be yours, checking");
      await tick();
      const opened = ss;
      const signer = new MasterSigner(WOTS_W16, { load: () => undefined, save: () => {} }, () => stealthWotsSeed(opened));
      const derived = await predictAccount(w16.factory, stealthConfig(signer.root, stealthCoSigner(keys.spendingPk, opened), genesis));
      if (derived === log.args.stealthAddress) s.privates.push({ account: derived, ss: bytesToHex(opened), claimed: false, signer: null });
    }
    s.scannedTo = head.toString();
    await persist();
    return (await engine.snapshot()).privatePayments;
  },

  async claimPrivate(id, to, onStep) {
    await config();
    const s = need().secrets;
    const entry = s.privates.find((p) => p.account === id);
    if (!entry) throw new Error("That payment isn't in this wallet.");
    const keys = stealthKeys();
    const ss = hexToBytes(entry.ss);
    const { genesis, paymaster } = deployments();
    const balance = await publicClient.getBalance({ address: entry.account });
    if (balance === 0n) throw new Error("There's nothing in that payment.");
    onStep("Opening the payment with your keys");
    await tick();
    const store: SignerStore = {
      load: () => entry.signer ?? undefined,
      save: (state) => void (entry.signer = state),
    };
    const signer = new MasterSigner(WOTS_W16, store, () => stealthWotsSeed(ss));
    const coSignerKey = bytesToHex(stealthSecretKey(keys.spendingSk, ss));
    const coSigner = privateKeyToAccount(coSignerKey).address;
    const call: Call = { target: to, value: balance, data: "0x", execution: 400_000n, state: 300_000n };
    const { tx } = await signStealthSpend({ signer, coSignerKey, coSigner, account: entry.account, epochSalt: genesis, paymaster, calls: [call], fees: FEES });
    await persist();
    onStep("Gas is covered by the paymaster, so this needs no ETH");
    const done = await land(tx, onStep);
    entry.claimed = true;
    await persist();
    record("private-claimed", `Claimed ${eth(balance)} ETH privately`, done.hash);
    return finished(done);
  },

  async setupRecovery(delaySeconds, onStep) {
    onStep("Writing your recovery paper");
    const secret = randomFieldElement();
    const done = await master([opsV2.setRecovery(recoveryCommitment(secret), BigInt(delaySeconds), recoveryGate(recoveryTicket(secret)))], onStep);
    record("recovery-set", "Recovery paper set", done.hash);
    return { paper: paperOf(secret), ...finished(done) };
  },

  async recover(paper, account, passphrase, onStep) {
    requirePassphrase(passphrase);
    if (stored()) throw new Error("There's already a wallet in this browser.");
    await config();
    const secret = secretOfPaper(paper);
    const { epochSalt } = await accountState(account);
    // A recovery pays for itself from the wallet, and a wallet that escaped has almost nothing left in it.
    if ((await publicClient.getBalance({ address: account })) < parseEther("0.005")) {
      onStep("Your wallet is nearly empty, so asking the sponsor to cover this");
      await api("/api/topup", { account });
    }
    onStep("Making a new hash key");
    await tick();
    const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const dailyKey = generatePrivateKey();
    const safeKey = generatePrivateKey();
    const safe = privateKeyToAccount(safeKey).address;
    const harborSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    await openNewSession(
      { account, dailyKey, seed, nextSeed: null, safe, safeKey, harborSalt, stealthSeed: newStealthSeed(), exit: null, notes: [], privates: [], scannedTo: "0", backedUp: false, mine: [] },
      passphrase,
    );
    const newRoot = treeOf(seed).root;
    onStep("Proving you hold the paper. The paper itself never leaves this device");
    const { proof, nullifier } = await proveRecovery({ secret, newRoot, account, epochSalt, chainId: DEVNET.chainId });
    const done = await land(recoveryTx({ account, newRoot, nullifier, proof, ticket: recoveryTicket(secret), fees: FEES }), onStep).catch((error) => {
      // Nothing landed, so this half made wallet must not look like a wallet.
      engine.forget();
      throw error;
    });
    const id = (await read<bigint>(account, "nextItem")) - 1n;
    const item = await read<{ executeAfter: bigint }>(account, "queuedItem", [id]);
    onStep(`Your old hash key can still cancel this. Waiting until ${new Date(Number(item.executeAfter) * 1000).toLocaleTimeString()}`);
    for (;;) {
      if ((await publicClient.getBlock()).timestamp > item.executeAfter) break;
      await sleep(3000);
    }
    onStep("Installing your new hash key");
    await api("/api/finish", { account, id: id.toString() });
    onStep("Giving the wallet a new wallet key and safe");
    const finishing = await master([ops.setDailyKey(privateKeyToAccount(dailyKey).address), ops.setHarbor(harborCommitment(safe, harborSalt))], onStep);
    record("recovered", "Recovered this wallet with the paper", finishing.hash);
    return finished(done);
  },

  async setupExit(onStep) {
    await config();
    const s = need().secrets;
    const { epochSalt } = await accountState(s.account);
    onStep("Making a second hash key, kept apart from the first");
    await tick();
    const seed = s.exit?.seed ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const root = treeOf(seed).root;
    const exit = s.exit?.address ?? (await api<{ exit: Address }>("/api/exit", { account: s.account, root, epochSalt })).exit;
    s.exit = { address: exit, seed };
    await persist();
    const done = await master([opsV2.setExit(exit)], onStep);
    record("exit-set", "Second way out is ready", done.hash);
    return finished(done);
  },

  async exitEscape(onStep) {
    await config();
    const s = need().secrets;
    if (!s.exit) throw new Error("Set up the second way out first.");
    const { epochSalt } = await accountState(s.account);
    onStep("Getting your second hash key ready");
    await tick();
    const signer = await catchUpLeaves(s.exit.seed, s.exit.address);
    onStep("Signing from the second way out");
    const { tx } = signExitTx({ signer, exit: s.exit.address, account: s.account, epochSalt, calls: [ops.escape(s.safe, s.harborSalt)], fees: FEES });
    const done = await land(tx, onStep);
    record("escaped", `Moved everything to your safe by the second way out`, done.hash);
    return finished(done);
  },

  async shield(onStep) {
    await config();
    const s = need().secrets;
    const v2 = deployments().v2!;
    const note = newNote();
    const commitment = noteCommitment(note);
    const saved = { id: commitment.toString().slice(0, 12), secret: note.secret.toString(), nullifierSeed: note.nullifierSeed.toString(), commitment: commitment.toString(), leaf: -1, spent: false };
    s.notes.push(saved);
    await persist();
    const done = await master([opsV2.shield(commitment, BigInt(v2.denomination))], onStep);
    saved.leaf = (await poolLeaves(s.account)).indexOf(commitment);
    await persist();
    record("shielded", `Put ${eth(BigInt(v2.denomination))} ETH in the private pool`, done.hash);
    return finished(done);
  },

  async unshield(noteId, to, onStep) {
    const { sponsor } = await config();
    const s = need().secrets;
    const v2 = deployments().v2!;
    const saved = s.notes.find((n) => n.id === noteId && !n.spent);
    if (!saved) throw new Error("That note is already spent.");
    if (await publicClient.getCode({ address: to })) {
      const trial = await publicClient.call({ account: sponsor, to, value: BigInt(v2.denomination) - BigInt(v2.noteFee) }).then(
        () => null,
        (error: Error) => error.message,
      );
      if (trial !== null) throw new Error("That address can't take a plain payment, so the note would be lost. Pick another address.");
    }
    const note = { secret: BigInt(saved.secret), nullifierSeed: BigInt(saved.nullifierSeed) };
    for (let attempt = 1; ; attempt++) {
      const leaves = await poolLeaves(s.account);
      const leaf = saved.leaf >= 0 ? saved.leaf : leaves.indexOf(BigInt(saved.commitment));
      if (leaf < 0) throw new Error("That note never reached the pool, so nothing was spent.");
      onStep("Proving the note is yours, without saying which one");
      const proved = await proveUnshield({ note, leaves, leaf, recipient: to, denomination: BigInt(v2.denomination), account: s.account, chainId: DEVNET.chainId });
      onStep("Doing the anti-spam work. This can take half a minute on a phone");
      await tick();
      const tx = unshieldTx({ account: s.account, root: proved.root, nullifierHash: proved.nullifierHash, recipient: to, proof: proved.proof, fees: FEES });
      try {
        const done = await land(tx, onStep);
        saved.spent = true;
        await persist();
        record("unshielded", `Took ${eth(BigInt(v2.denomination) - BigInt(v2.noteFee))} ETH out of the pool to ${short(to)}`, done.hash);
        return finished(done);
      } catch (error) {
        if (/moved on/.test((error as Error).message) && attempt < 3) continue;
        throw error;
      }
    }
  },

  async telegramLink() {
    const { telegramBot } = await config();
    if (!telegramBot) throw new Error("Telegram alerts aren't switched on for this service.");
    const { account } = need().secrets;
    await api("/api/alerts/watch", { account });
    return `https://t.me/${telegramBot}?start=${account.slice(2)}`;
  },

  async enablePush() {
    const { vapidPublic } = await config();
    const { account } = need().secrets;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser can't do push alerts. On an iPhone, add VAJRA to your home screen first, or use Telegram.");
    if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser settings.");
    const registration = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(vapidPublic.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
    await api("/api/alerts/push", { account, subscription: subscription.toJSON() });
  },

  async moveHashKeyLink() {
    const s = need();
    const seed = needHashKey();
    const state = leafStore(seed).load()!;
    const payload = { account: s.secrets.account, seed, safe: s.secrets.safe, harborSalt: s.secrets.harborSalt, nextLeaf: state.nextLeaf };
    return `${location.origin}/#/link/${encode(await seal(s.key, s.salt, payload))}`;
  },

  async confirmMoved() {
    const s = need();
    s.secrets.seed = null;
    await persist();
    trees = new Map();
  },

  async receiveHashKey(link, passphrase) {
    if (stored()) throw new Error("There's already a wallet in this browser.");
    await config();
    const text = link.replace(/^.*#\/link\//, "");
    const { value, key, salt } = await open<{ account: Address; seed: Hex; safe: Address; harborSalt: Hex; nextLeaf: number }>(decode(text), passphrase);
    leafStore(value.seed).save({ seed: value.seed, nextLeaf: value.nextLeaf, revealed: {} });
    session = {
      key,
      salt,
      secrets: { account: value.account, dailyKey: null, seed: value.seed, nextSeed: null, safe: value.safe, safeKey: null, harborSalt: value.harborSalt, stealthSeed: null, exit: null, notes: [], privates: [], scannedTo: "0", backedUp: true, mine: [] },
    };
    trees = new Map();
    await persist();
  },
};

/** For the end to end test, which runs this same file in Node. */
export const internals = { config, need };
void exitTicket;
