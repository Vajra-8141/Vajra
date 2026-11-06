/** The window that asks the owner. What it shows was decoded by the background from the request itself, not from anything a site said. */
import type { Approval } from "./engine.ts";
import { ask, field, h } from "./ui.ts";

const root = document.getElementById("app")!;
const id = Number(new URLSearchParams(location.search).get("id"));

// Keeps the worker, and the request it is holding, alive for as long as the owner takes to read this.
const port = chrome.runtime.connect({ name: "keepalive" });
setInterval(() => port.postMessage("ping"), 20_000);

async function answer(ok: boolean, password?: string) {
  try {
    await ask({ type: "approval-answer", id, ok, password });
    window.close();
  } catch (error) {
    document.getElementById("error")?.replaceChildren((error as Error).message);
  }
}

function connect(request: Extract<Approval, { kind: "connect" }>) {
  return [
    h("h1", {}, "Connect this site?"),
    h("div", { class: "mono", id: "origin" }, request.origin),
    h("p", { class: "muted" }, "It will see your account's address and balance. It cannot move anything without asking you here."),
    h("div", { class: "mono" }, request.account),
    h("p", { class: "unknown", id: "error" }),
    h("button", { id: "approve", class: "primary", click: () => void answer(true) }, "Connect"),
    h("button", { id: "reject", click: () => void answer(false) }, "Refuse"),
  ];
}

function payment(request: Extract<Approval, { kind: "payment" }>, locked: boolean) {
  const password = field("password", "Password", "password");
  const refused = request.forecast.outcome === "refused";
  return [
    h("h1", { id: "amount" }, `Pay ${request.amountText}`),
    h("div", { class: "muted", id: "origin" }, `Asked by ${request.origin}`),
    ...request.warnings.map((warning) => h("div", { class: `warn ${warning.level}`, "data-warning": warning.code }, warning.text)),
    h("div", { class: "card" }, h("h2", {}, "To"), h("div", { id: "payee" }, request.label ?? "No label"), h("div", { class: "mono", id: "recipient" }, request.recipient)),
    h("div", { class: "card" }, h("h2", {}, "What will happen"), h("div", { id: "forecast", "data-outcome": request.forecast.outcome }, request.forecast.text)),
    locked ? password : null,
    h("p", { class: "unknown", id: "error" }),
    h("button", { id: "approve", class: "primary", disabled: refused, click: () => void answer(true, password.value) }, "Sign with the daily key"),
    h("button", { id: "reject", click: () => void answer(false) }, "Refuse"),
  ];
}

void ask<{ request: Approval; locked: boolean } | null>({ type: "approval", id }).then((found) => {
  if (!found) return root.replaceChildren("This request has gone.");
  const screen = found.request.kind === "connect" ? connect(found.request) : payment(found.request, found.locked);
  root.replaceChildren(...screen.filter((node): node is HTMLElement => node !== null));
});
