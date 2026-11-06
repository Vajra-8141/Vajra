/**
 * The owner's remote control. It holds a pairing token and a passkey, and no key that can sign for the account: the master key stays
 * with the local service, which decides whether a tap may reach it. Every value on screen comes from that service, and a failed read
 * is shown as unknown.
 */
interface Warning {
  level: "danger" | "caution";
  text: string;
}

interface Item {
  id: string;
  kind: "payment" | "recovery";
  recipient: string;
  label: string | null;
  amountText: string;
  secondsLeft: number;
  reasonText: string;
  warnings: Warning[];
  headline: string;
}

interface State {
  mirror: boolean;
  chainId: number;
  signer: "software" | "hardware";
  payAllowed: boolean;
  passkey: boolean;
  pushReady: boolean;
  account: string | null;
  review: { balanceText: string; leftText: string; frozen: boolean; items: Item[] } | null;
  unknown: string | null;
}

const TOKEN = "vajra.token";
const root = document.getElementById("app")!;

const token = () => {
  try {
    return localStorage.getItem(TOKEN);
  } catch {
    return null;
  }
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token() ?? ""}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

/** Text always goes in as text: a label is the owner's, but an address comes from whoever sent the payment. */
function h(tag: string, attrs: Record<string, string | boolean | (() => void)> = {}, ...children: (Node | string | null)[]) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "function") el.addEventListener(name, value);
    else if (value === true) el.setAttribute(name, "");
    else if (value !== false) el.setAttribute(name, value);
  }
  for (const child of children) if (child !== null) el.append(child);
  return el;
}

const shorten = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let state: State | null = null;
let failure: string | null = null;
let outcome: { id: string; text: string; ok: boolean } | null = null;
let busy = false;
let notice: string | null = null;

const openItem = () => /^#item=(\d+)$/.exec(location.hash)?.[1] ?? null;

function header() {
  return h("div", { class: "top" }, h("span", { class: "mark" }, "VAJRA"), h("span", { class: "muted" }, state?.account ? shorten(state.account) : ""));
}

function mirrorBanner() {
  return state?.mirror ? h("div", { class: "banner", id: "mirror" }, `Local mirror, chain ${state.chainId}. Not the public devnet.`) : null;
}

function warnings(item: Item) {
  return item.warnings.map((warning) => h("div", { class: `warn ${warning.level}`, "data-warning": warning.level }, warning.text));
}

function left(seconds: number) {
  return seconds > 0 ? `${Math.ceil(seconds / 60)} min left` : "Ready to leave now";
}

async function setupPush() {
  try {
    if (!("PushManager" in window)) throw new Error("this browser has no Web Push");
    if ((await Notification.requestPermission()) !== "granted") throw new Error("notifications are not allowed");
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(publicKey) });
    await api("/api/push/subscribe", subscription.toJSON());
    notice = "Alerts are on.";
  } catch (error) {
    notice = `Alerts are not on: ${(error as Error).message}. Telegram is the backup: see \`vajra watch\`.`;
  }
  await refresh();
}

async function setupPasskey() {
  try {
    const begin = await api<{ challenge: string; rpId: string; userId: string }>("/api/passkey/begin", {});
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: unb64(begin.challenge),
        rp: { id: begin.rpId, name: "VAJRA" },
        user: { id: unb64(begin.userId), name: "owner", displayName: "VAJRA owner" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        attestation: "none",
      },
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAttestationResponse;
    const publicKey = response.getPublicKey();
    if (!publicKey) throw new Error("this browser did not give the passkey's public key");
    await api("/api/passkey/finish", { id: credential.id, publicKey: b64(publicKey), algorithm: response.getPublicKeyAlgorithm(), clientDataJSON: b64(response.clientDataJSON) });
    notice = "Passkey set.";
  } catch (error) {
    notice = `No passkey: ${(error as Error).message}`;
  }
  await refresh();
}

async function assertion(id: string) {
  const { challenge, rpId, credentialId } = await api<{ challenge: string; rpId: string; credentialId: string }>("/api/passkey/challenge", { id });
  const credential = (await navigator.credentials.get({
    publicKey: { challenge: unb64(challenge), rpId, userVerification: "required", allowCredentials: [{ type: "public-key", id: unb64(credentialId) }] },
  })) as PublicKeyCredential;
  const response = credential.response as AuthenticatorAssertionResponse;
  return { id: credential.id, clientDataJSON: b64(response.clientDataJSON), authenticatorData: b64(response.authenticatorData), signature: b64(response.signature) };
}

async function respond(action: "veto" | "pay", id: string) {
  busy = true;
  outcome = { id, text: action === "pay" ? "Checking your passkey, then signing with the hash key…" : "Signing with the hash key…", ok: true };
  render();
  try {
    const body = action === "pay" ? { action, id, assertion: await assertion(id) } : { action, id };
    const result = await api<{ block: number }>("/api/answer", body);
    outcome = { id, ok: true, text: `${action === "pay" ? "Paid" : "Cancelled"}. Signed by the hash key, in block ${result.block}.` };
  } catch (error) {
    outcome = { id, ok: false, text: (error as Error).message };
  }
  busy = false;
  await refresh();
}

async function saveLabel(address: string, input: HTMLInputElement) {
  try {
    await api("/api/labels", { address, label: input.value });
    notice = "Label saved.";
  } catch (error) {
    notice = (error as Error).message;
  }
  await refresh();
}

function reviewScreen(item: Item | undefined, id: string) {
  const back = h("button", { class: "link", click: () => void (location.hash = "") }, "Back to the account");
  const result = outcome?.id === id ? h("div", { class: `card ${outcome.ok ? "done" : "unknown"}`, id: "outcome" }, outcome.text) : null;
  if (!item) return [header(), mirrorBanner(), back, result ?? h("p", { class: "muted" }, `Item ${id} is no longer waiting.`)];

  const payOff = !state!.payAllowed;
  const needsPasskey = !state!.passkey;
  const name = h("input", { id: "label", placeholder: "Name this address", "aria-label": "Name this address", value: item.label ?? "" }) as HTMLInputElement;
  return [
    header(),
    mirrorBanner(),
    back,
    h("h1", { id: "headline" }, item.headline),
    ...warnings(item),
    h(
      "div",
      { class: "card" },
      h("h2", {}, item.kind === "recovery" ? "What is changing" : "Amount"),
      h("div", { class: "big", id: "amount" }, item.amountText),
      h("h2", {}, "To"),
      h("div", { id: "payee" }, item.label ?? "No label"),
      h("div", { class: "mono", id: "recipient" }, item.recipient),
      h("h2", {}, "Why it is waiting"),
      h("div", { id: "reason" }, item.reasonText),
      h("div", { class: "muted", id: "time" }, left(item.secondsLeft)),
    ),
    result,
    h("button", { class: "stop", id: "not-me", disabled: busy, click: () => void respond("veto", id) }, "Not me"),
    item.kind === "payment" ? h("button", { class: "go", id: "pay", disabled: busy || payOff || needsPasskey, click: () => void respond("pay", id) }, "Pay, it's me") : null,
    item.kind === "recovery"
      ? h("p", { class: "muted" }, "A new key tree cannot be released early, so there is no Pay here.")
      : payOff
        ? h("p", { class: "muted", id: "pay-note" }, "Pay is off: it needs the hardware signer, so that a phone alone cannot move money.")
        : needsPasskey
          ? h("p", { class: "muted", id: "pay-note" }, "Pay needs a passkey. Set one up on the account screen.")
          : h("p", { class: "muted", id: "pay-note" }, "Pay asks for your passkey. That check is on this phone and in your local service. The contracts do not know about it."),
    item.kind === "payment" ? h("div", { class: "card" }, h("h2", {}, "Address book"), name, h("button", { id: "save-label", click: () => void saveLabel(item.recipient, name) }, "Save label")) : null,
  ];
}

function accountScreen() {
  const review = state!.review;
  const value = (text: string | undefined, id: string) => h("span", { class: text === undefined ? "big unknown" : "big", id }, text ?? "unknown");
  const queue = review
    ? review.items.length
      ? review.items.map((item) =>
          h(
            "button",
            { class: "item", "data-item": item.id, click: () => void (location.hash = `item=${item.id}`) },
            h("span", {}, item.headline),
            ...item.warnings.slice(0, 1).map((warning) => h("span", { class: "muted" }, warning.text)),
          ),
        )
      : [h("p", { class: "muted", id: "empty" }, "Nothing is waiting.")]
    : [h("p", { class: "unknown", id: "queue-unknown" }, "The queue is unknown right now. That does not mean it is empty.")];

  return [
    header(),
    mirrorBanner(),
    state!.account ? null : h("div", { class: "card" }, "No account on this service yet."),
    state!.unknown ? h("div", { class: "warn caution", id: "unknown" }, `Could not read the chain: ${state!.unknown}`) : null,
    review?.frozen ? h("div", { class: "warn caution" }, "The account is frozen.") : null,
    h(
      "div",
      { class: "card" },
      h("div", { class: "row" }, h("h2", {}, "Balance"), value(review?.balanceText, "balance")),
      h("div", { class: "row" }, h("h2", {}, "Daily limit left"), value(review?.leftText, "left")),
    ),
    h("h2", {}, "Waiting in the public queue"),
    ...queue,
    notice ? h("p", { class: "muted", id: "notice" }, notice) : null,
    h(
      "div",
      { class: "card" },
      h("h2", {}, "This phone"),
      h("div", {}, `Master key: on your computer, ${state!.signer} signer. This phone never holds it.`),
      h("button", { id: "push", disabled: state!.pushReady, click: () => void setupPush() }, state!.pushReady ? "Alerts are on" : "Turn on alerts"),
      h("button", { id: "passkey", disabled: state!.passkey, click: () => void setupPasskey() }, state!.passkey ? "Passkey is set" : "Set up a passkey for Pay"),
      h("p", { class: "muted" }, "The passkey is a client-side check: on this phone and in your local service. It does not change the contracts."),
    ),
  ];
}

function pairScreen() {
  return [
    h("div", { class: "top" }, h("span", { class: "mark" }, "VAJRA")),
    h("h1", {}, "Pair this phone"),
    h("p", { class: "muted", id: "pair-note" }, failure ?? "Run `vajra phone` on your computer, and open the link it writes to phone-pair.txt."),
  ];
}

function render() {
  // A half-typed label must survive the poll.
  if (document.activeElement instanceof HTMLInputElement) return;
  const id = openItem();
  let screen: (Node | null)[];
  if (!token()) screen = pairScreen();
  else if (!state) screen = [header(), h("p", { class: "unknown", id: "loading" }, failure ?? "Reading the account…")];
  else if (id) screen = reviewScreen(state.review?.items.find((item) => item.id === id), id);
  else screen = accountScreen();
  root.replaceChildren(...screen.filter((node): node is Node => node !== null));
}

async function refresh() {
  if (!token()) return render();
  try {
    state = await api<State>("/api/state");
    failure = null;
  } catch (error) {
    // A dead service leaves nothing to trust on screen, so the old numbers go.
    state = null;
    failure = `The local service did not answer, so everything here is unknown: ${(error as Error).message}`;
  }
  render();
}

async function pairFromLink() {
  const code = /^#pair=([\w-]+)$/.exec(location.hash)?.[1];
  if (!code) return;
  history.replaceState(null, "", "/");
  try {
    const { token: issued } = await api<{ token: string }>("/api/pair", { code, kind: "phone" });
    localStorage.setItem(TOKEN, issued);
  } catch (error) {
    failure = (error as Error).message;
  }
}

window.addEventListener("hashchange", render);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
void pairFromLink().then(refresh);
setInterval(() => void (busy ? null : refresh()), 3000);
