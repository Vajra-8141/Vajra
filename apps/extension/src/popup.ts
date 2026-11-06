/**
 * The toolbar popup: balance, limit left, the queue, a payment, and the address book. Reads go straight to the node from here, and a
 * read that fails is shown as unknown. Cancelling needs the master key, so this page can only point at the phone.
 */
import type { Address } from "viem";
import { type Book, shortAddress } from "@vajra/shared/addressbook";
import { type Review, readReview } from "@vajra/shared/review";
import { ask, field, h } from "./ui.ts";

interface Status {
  account: Address | null;
  unlocked: boolean;
  mirror: boolean;
  chainId: number;
  sites: string[];
  linked: string | null;
}

const root = document.getElementById("app")!;
let message: string | null = null;

const say = (text: string) => {
  message = text;
};

async function act(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    say((error as Error).message);
  }
  await render();
}

function banner(status: Status) {
  return status.mirror ? h("div", { class: "banner", id: "mirror" }, `Local mirror, chain ${status.chainId}. Not the public devnet.`) : null;
}

function setup(status: Status) {
  const account = field("import-account", "VAJRA account address");
  const key = field("import-key", "Daily key", "password");
  const password = field("import-password", "A password for this browser", "password");
  return [
    banner(status),
    h("h1", {}, "Set up"),
    h("button", { id: "open-move", class: "primary", click: () => void chrome.tabs.create({ url: chrome.runtime.getURL("move.html") }) }, "Move a wallet into a new account"),
    h("h2", {}, "Or use an account you already have"),
    account,
    key,
    password,
    h("button", { id: "import", click: () => void act(() => ask({ type: "import", account: account.value, key: key.value, password: password.value })) }, "Import the daily key"),
    h("p", { class: "muted" }, "Only the daily key goes here. The master key stays with your signer."),
  ];
}

function queueView(review: Review | null) {
  if (!review) return [h("p", { class: "unknown", id: "queue-unknown" }, "The queue is unknown right now. That does not mean it is empty.")];
  if (!review.items.length) return [h("p", { class: "muted", id: "queue-empty" }, "Nothing is waiting.")];
  return [
    ...review.items.map((item) =>
      h("div", { class: "card", "data-item": item.id }, h("div", {}, item.headline), ...item.warnings.slice(0, 1).map((warning) => h("div", { class: `warn ${warning.level}` }, warning.text))),
    ),
    h("p", { class: "muted" }, "To cancel, answer on your phone. That takes the master key, which is not here."),
  ];
}

function main(status: Status, review: Review | null, book: Book, failure: string | null) {
  const value = (text: string | undefined, id: string) => h("span", { class: text === undefined ? "big unknown" : "big", id }, text ?? "unknown");
  const to = field("to", "Recipient address");
  const amount = field("amount", "Amount in ETH");
  const labelAddress = field("label-address", "Address");
  const labelName = field("label-name", "Label");
  const pairing = field("link-url", "Pairing link from phone-pair.txt");
  const password = field("unlock-password", "Password", "password");

  return [
    h("div", { class: "top" }, h("span", { class: "mark" }, "VAJRA"), h("span", { class: "mono", id: "account", title: status.account! }, shortAddress(status.account!))),
    banner(status),
    failure ? h("div", { class: "warn caution", id: "read-failed" }, `Could not read the chain: ${failure.slice(0, 120)}`) : null,
    review?.frozen ? h("div", { class: "warn caution" }, "The account is frozen.") : null,
    h(
      "div",
      { class: "card" },
      h("div", { class: "row" }, h("h2", {}, "Balance"), value(review?.balanceText, "balance")),
      h("div", { class: "row" }, h("h2", {}, "Daily limit left"), value(review?.leftText, "left")),
    ),
    h("h2", {}, "Waiting in the public queue"),
    ...queueView(review),
    message ? h("p", { class: "muted", id: "message" }, message) : null,
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Pay"),
      to,
      amount,
      h("button", { id: "pay", class: "primary", click: () => void act(async () => say(`Sent: ${await ask<string>({ type: "pay", to: to.value, amount: amount.value })}`)) }, "Review and pay"),
    ),
    h(
      "div",
      { class: "card", id: "book" },
      h("h2", {}, "Address book"),
      ...Object.entries(book).map(([address, entry]) => h("div", { class: "row", "data-label": address }, h("span", {}, entry.label), h("span", { class: "mono" }, shortAddress(address)))),
      labelAddress,
      labelName,
      h("button", { id: "save-label", click: () => void act(() => ask({ type: "label", address: labelAddress.value, label: labelName.value })) }, "Save label"),
    ),
    status.linked ? h("p", { class: "muted", id: "linked" }, `Labels shared with ${status.linked}`) : h("div", { class: "card" }, h("h2", {}, "Share labels with the phone"), pairing, h("button", { id: "link", click: () => void act(() => ask({ type: "link", url: pairing.value })) }, "Link")),
    status.sites.length ? h("div", { class: "card" }, h("h2", {}, "Connected sites"), ...status.sites.map((site) => h("div", { class: "row" }, h("span", { class: "mono" }, site), h("a", { href: "#", "data-disconnect": site, click: () => void act(() => ask({ type: "disconnect", origin: site })) }, "Disconnect")))) : null,
    status.unlocked
      ? h("button", { id: "lock", click: () => void act(() => ask({ type: "lock" })) }, "Lock")
      : h("div", { class: "card" }, h("h2", {}, "Locked"), password, h("button", { id: "unlock", click: () => void act(() => ask({ type: "unlock", password: password.value })) }, "Unlock")),
  ];
}

async function render() {
  const status = await ask<Status>({ type: "status" });
  if (!status.account) return root.replaceChildren(...setup(status).filter((node): node is HTMLElement => node !== null));
  const book = await ask<Book>({ type: "book" });
  let review: Review | null = null;
  let failure: string | null = null;
  try {
    review = await readReview(status.account, book);
  } catch (error) {
    failure = (error as Error).message;
  }
  root.replaceChildren(...main(status, review, book, failure).filter((node): node is HTMLElement => node !== null));
}

void render();
