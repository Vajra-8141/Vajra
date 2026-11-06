/**
 * The phone app's local service: serves the PWA, watches the queue, sends Web Push, and answers **Not me** and **Pay, it's me**.
 *
 * The phone holds no key that can move money. It holds a bearer token and a passkey, and both only ask this process to act. The same
 * gate as the Telegram watcher sits in front of the master key: `decide` from watch.ts, including its rule that Pay needs the
 * hardware signer unless --allow-software-pay says otherwise. The passkey comes on top of that, and it is a check in this process
 * and on the phone. No contract knows about it.
 *
 * It listens on loopback only. Any web page can reach localhost, so the Host and Origin checks and the token are what stop one
 * from asking this process for anything. Telegram stays as the backup: `vajra watch` can run beside this, and the signer lock keeps
 * the two from using one leaf.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname, extname, join, relative } from "node:path";
import type { Address, Hex } from "viem";
import { DEVNET, RpcError, isLocalStack, refusalName } from "@vajra/core";
import { type Book, removeLabel, setLabel } from "@vajra/shared/addressbook";
import { type Review, readReview } from "@vajra/shared/review";
import { keyPath } from "./deploy.ts";
import { type MoveRequest, finishMove, prepareMove } from "./move.ts";
import { type Assertion, Challenges, type StoredPasskey, acceptRegistration, verifyAssertion } from "./passkey.ts";
import { loadWallet, runMasterOp } from "./wallet.ts";
import { localRescueMargin } from "./nominee.ts";
import { decide, readQueue, rescueNotice } from "./watch.ts";
import { type PushSubscription, type Vapid, newVapid, sendPush } from "./webpush.ts";

const MAX_BODY = 16_384;
const PAIR_MS = 10 * 60_000;
const POLL_MS = 2000;
const PHONE_DIST = new URL("../../../apps/phone/dist/", import.meta.url).pathname;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

interface Client {
  id: number;
  kind: "phone" | "extension";
  tokenHash: string;
  pairedAt: number;
}

interface PhoneState {
  nextClient: number;
  clients: Client[];
  passkey: StoredPasskey | null;
  subscriptions: PushSubscription[];
}

const statePath = () => keyPath("phone.json");
const bookPath = () => keyPath("addressbook.json");
const vapidPath = () => keyPath("vapid.json");
const pairPath = () => keyPath("phone-pair.txt");

function loadJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function saveJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1), { mode: 0o600 });
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function sameHash(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class Refusal extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Refusal(415, "send JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Refusal(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

/** Only loopback, and https: a phone must not be able to point this process at another machine on the network. */
function pushEndpointAllowed(endpoint: string) {
  const url = new URL(endpoint);
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1");
}

function staticFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(`/${relative(PHONE_DIST, path)}`, path);
    }
  };
  if (existsSync(PHONE_DIST)) walk(PHONE_DIST);
  files.set("/", join(PHONE_DIST, "index.html"));
  return files;
}

export interface PhoneOptions {
  allowSoftwarePay: boolean;
  port: number;
}

export function startPhone(o: PhoneOptions): Server {
  const origin = process.env.VAJRA_PHONE_ORIGIN ?? `http://localhost:${o.port}`;
  const { hostname: rpId, host: publicHost } = new URL(origin);
  const hosts = new Set([publicHost, `localhost:${o.port}`, `127.0.0.1:${o.port}`]);
  const hardware = process.env.VAJRA_SIGNER === "device";

  const state = loadJson<PhoneState>(statePath(), { nextClient: 1, clients: [], passkey: null, subscriptions: [] });
  const save = () => saveJson(statePath(), state);
  let book = loadJson<Book>(bookPath(), {});

  if (!existsSync(vapidPath())) saveJson(vapidPath(), newVapid(process.env.VAJRA_VAPID_SUBJECT ?? "mailto:owner@localhost"));
  const vapid = loadJson<Vapid>(vapidPath(), null as never);

  // The code goes in a file only this user can read. A terminal gets scrolled, shared and recorded.
  const pairCode = randomBytes(16).toString("base64url");
  const pairHash = hash(pairCode);
  const pairExpires = Date.now() + PAIR_MS;
  const pairedThisRun = new Set<string>();
  mkdirSync(dirname(pairPath()), { recursive: true });
  writeFileSync(pairPath(), `${origin}/#pair=${pairCode}\n`, { mode: 0o600 });

  const challenges = new Challenges();
  const files = staticFiles();
  const owner = () => state.clients.find((client) => client.kind === "phone")?.id ?? -1;

  function authenticate(req: IncomingMessage): Client {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const client = bearer ? state.clients.find((known) => sameHash(known.tokenHash, hash(bearer))) : undefined;
    if (!client) throw new Refusal(401, "This device is not paired.");
    return client;
  }

  function requirePhone(req: IncomingMessage): Client {
    const client = authenticate(req);
    if (client.kind !== "phone") throw new Refusal(403, "Only the phone can do this.");
    return client;
  }

  async function currentState() {
    const wallet = loadWallet();
    const base = {
      mirror: isLocalStack,
      chainId: DEVNET.chainId,
      signer: hardware ? "hardware" : "software",
      payAllowed: hardware || o.allowSoftwarePay,
      passkey: state.passkey !== null,
      pushReady: state.subscriptions.length > 0,
      account: wallet?.account ?? null,
    };
    if (!wallet) return { ...base, review: null, unknown: null };
    try {
      return { ...base, review: await readReview(wallet.account, book), unknown: null };
    } catch (error) {
      // Unknown is a state of its own. The app shows this, and never a balance of zero or an empty queue.
      return { ...base, review: null, unknown: (error as Error).message.slice(0, 200) };
    }
  }

  /** The tap, as `decide` wants it. Pending ids come from the chain at this moment, not from what the phone was showing. */
  async function answer(client: Client, body: Record<string, unknown>) {
    const wallet = loadWallet();
    if (!wallet) throw new Refusal(409, "There is no account here yet.");
    const action = body.action === "veto" || body.action === "pay" ? body.action : null;
    const id = typeof body.id === "string" ? body.id : "";
    const fresh = await readQueue(wallet.account);
    const decision = decide(
      { from: client.id, data: `${action}:${id}` },
      { owner: owner(), pending: new Set(fresh.items.map((item) => item.id)), recoveries: fresh.recoveries, hardware, allowSoftwarePay: o.allowSoftwarePay },
    );
    if (!decision.ok) throw new Refusal(403, decision.reason);

    if (decision.button.action === "pay") {
      if (!state.passkey) throw new Refusal(403, "Pay needs a passkey on this phone. Set one up first.");
      const purpose = `pay:${decision.button.id}`;
      const challenge = challenges.take(purpose);
      if (!challenge) throw new Refusal(403, "That passkey check expired. Try again.");
      try {
        state.passkey.signCount = verifyAssertion({ stored: state.passkey, assertion: body.assertion as Assertion, challenge, origin, rpId });
      } catch (error) {
        throw new Refusal(403, `Passkey refused: ${(error as Error).message}`);
      }
      save();
    }

    console.log(`${decision.button.action} of item ${decision.button.id}, asked from the phone`);
    const result = await runMasterOp({ op: decision.button.action, id: decision.button.id.toString() }, console.log);
    console.log(`mined ${result.hash}, leaf ${result.leaf}, ${result.leavesLeft} left`);
    return { hash: result.hash, block: result.block, verifyGas: result.verifyGas, leaf: result.leaf, leavesLeft: result.leavesLeft };
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const post = req.method === "POST";
    if (req.method === "GET" && path === "/api/hello") return send(res, 200, { vajra: "phone", mirror: isLocalStack, chainId: DEVNET.chainId });

    if (post && path === "/api/pair") {
      const body = await jsonBody(req);
      const kind = body.kind === "extension" ? "extension" : "phone";
      if (Date.now() > pairExpires || typeof body.code !== "string" || !sameHash(hash(body.code), pairHash) || pairedThisRun.has(kind)) throw new Refusal(403, "That pairing code is not valid. Restart `vajra phone` for a new one.");
      pairedThisRun.add(kind);
      const token = randomBytes(32).toString("base64url");
      // One phone. A new one takes over, and what was tied to the old one goes with it.
      if (kind === "phone") {
        state.clients = state.clients.filter((client) => client.kind !== "phone");
        state.passkey = null;
        state.subscriptions = [];
      } else {
        state.clients = state.clients.filter((client) => client.kind !== "extension");
      }
      state.clients.push({ id: state.nextClient++, kind, tokenHash: hash(token), pairedAt: Date.now() });
      save();
      console.log(`paired a ${kind}`);
      return send(res, 200, { token });
    }

    if (req.method === "GET" && path === "/api/state") return authenticate(req), send(res, 200, await currentState());
    if (req.method === "GET" && path === "/api/labels") return authenticate(req), send(res, 200, book);
    if (post && path === "/api/labels") {
      authenticate(req);
      const body = await jsonBody(req);
      book = typeof body.label === "string" && body.label ? setLabel(book, String(body.address), body.label) : removeLabel(book, String(body.address));
      saveJson(bookPath(), book);
      return send(res, 200, book);
    }

    if (req.method === "GET" && path === "/api/push/key") return authenticate(req), send(res, 200, { publicKey: vapid.publicKey });
    if (post && path === "/api/push/subscribe") {
      requirePhone(req);
      const subscription = (await jsonBody(req)) as unknown as PushSubscription;
      if (typeof subscription.endpoint !== "string" || !subscription.keys?.p256dh || !subscription.keys.auth) throw new Refusal(400, "That is not a push subscription.");
      if (!pushEndpointAllowed(subscription.endpoint)) throw new Refusal(400, "A push endpoint has to be https.");
      state.subscriptions = [...state.subscriptions.filter((known) => known.endpoint !== subscription.endpoint), subscription];
      save();
      return send(res, 200, { subscribed: true });
    }

    if (post && path === "/api/passkey/begin") {
      requirePhone(req);
      return send(res, 200, { challenge: challenges.issue("register"), rpId, userId: randomBytes(16).toString("base64url") });
    }
    if (post && path === "/api/passkey/finish") {
      requirePhone(req);
      const body = await jsonBody(req);
      const challenge = challenges.take("register");
      if (!challenge) throw new Refusal(403, "That passkey setup expired. Try again.");
      state.passkey = acceptRegistration({ id: String(body.id), publicKey: String(body.publicKey), algorithm: Number(body.algorithm), clientDataJSON: String(body.clientDataJSON), challenge, origin });
      save();
      return send(res, 200, { passkey: true });
    }
    if (post && path === "/api/passkey/challenge") {
      requirePhone(req);
      const body = await jsonBody(req);
      if (!state.passkey) throw new Refusal(403, "No passkey is set up on this phone.");
      if (typeof body.id !== "string" || !/^\d{1,18}$/.test(body.id)) throw new Refusal(400, "Which item?");
      return send(res, 200, { challenge: challenges.issue(`pay:${BigInt(body.id)}`), rpId, credentialId: state.passkey.id });
    }

    if (post && path === "/api/answer") return send(res, 200, await answer(authenticate(req), await jsonBody(req)));

    if (post && path === "/api/move/plan") {
      authenticate(req);
      const prepared = await prepareMove((await jsonBody(req)) as unknown as MoveRequest);
      return send(res, 200, { ...prepared, options: { ...prepared.options, stake: prepared.options.stake.toString() } });
    }
    if (post && path === "/api/move/done") {
      authenticate(req);
      const body = await jsonBody(req);
      const wallet = await finishMove(body.hash as Hex);
      return send(res, 200, { account: wallet.account as Address });
    }

    const file = req.method === "GET" ? files.get(path) : undefined;
    if (file && existsSync(file)) {
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        "x-content-type-options": "nosniff",
      });
      return void res.end(readFileSync(file));
    }
    send(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    // A hostile page can point its own domain at 127.0.0.1. The Host header is what gives that away.
    if (!hosts.has(req.headers.host ?? "")) return send(res, 403, { error: "this host is not served here" });
    const from = req.headers.origin;
    if (from !== undefined && from !== origin && !from.startsWith("chrome-extension://") && path.startsWith("/api/")) return send(res, 403, { error: "only the phone app may use this service" });

    route(req, res, path).catch((error: Error) => {
      const refused = error instanceof Refusal;
      const message = error instanceof RpcError ? refusalName(error.message) : error.message;
      if (!refused) console.log(`refused: ${message}`);
      send(res, refused ? error.status : 400, { error: message });
    });
  });

  server.listen(o.port, "127.0.0.1", () => {
    console.log(`phone service on ${origin}, loopback only`);
    console.log(`signer: ${hardware ? "hardware" : "software"}, Pay ${hardware || o.allowSoftwarePay ? "on" : "off"}`);
    if (!hardware && o.allowSoftwarePay) console.log("WARNING: Pay is on with a software signer. A phone tap and its passkey can now move money.");
    console.log(`to pair, open the link in ${pairPath()} on the phone. It works for 10 minutes.`);
    if (!existsSync(join(PHONE_DIST, "index.html"))) console.log("The app is not built: run `pnpm --filter @vajra/phone build`.");
  });

  const alerted = new Set<string>();
  const timer = setInterval(() => void watchQueue().catch((error: Error) => console.log(`phone: ${error.message}`)), POLL_MS);
  server.on("close", () => clearInterval(timer));
  let busy = false;

  /** Alerts on what is new. What the alert says is encrypted to the phone, so the push service sees only ciphertext. */
  async function watchQueue() {
    const wallet = loadWallet();
    if (busy || !wallet) return;
    busy = true;
    try {
      const review: Review = await readReview(wallet.account, book);
      for (const item of review.items) {
        if (alerted.has(item.id)) continue;
        if (!state.subscriptions.length) continue;
        const payload = { title: item.kind === "recovery" ? "Your master key is being replaced" : "A payment is waiting", body: `${item.headline}${rescueNotice(item.secondsLeft, localRescueMargin())} Was this you?`, id: item.id };
        const results = await Promise.all(state.subscriptions.map(async (subscription) => ({ subscription, result: await sendPush(vapid, subscription, payload) })));
        state.subscriptions = results.filter(({ result }) => result !== "gone").map(({ subscription }) => subscription);
        save();
        const delivered = results.some(({ result }) => result === "sent");
        for (const { result } of results) if (typeof result === "object") console.log(`push failed: ${result.failed}`);
        if (delivered) {
          alerted.add(item.id);
          console.log(`alerted: item ${item.id}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  return server;
}
