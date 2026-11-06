/**
 * Moving a wallet into a new account, from a page. The local service makes the master key and keeps it. The wallet's key is typed here,
 * signs here, and goes no further than this extension, where it becomes the daily key.
 *
 * Mirror only for now: the service refuses anywhere else.
 */
import { type Address, type Hex, formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { predictAccount } from "@vajra/core/account";
import { simulate } from "@vajra/core/admission";
import { framesSucceeded, signDailyTx, submit } from "@vajra/core/frame";
import { type MoveOptions, type MovePlan, moveConfig, planMove, readHoldings } from "@vajra/shared/move";
import { ask, field, h } from "./ui.ts";

const root = document.getElementById("app")!;

const pairing = field("pair", "Pairing link from phone-pair.txt");
const key = field("key", "The wallet's private key", "password");
const harbor = field("harbor", "Harbor: the one safe address an escape can send to");
const tokens = field("tokens", "Tokens to move, comma separated");
const limit = field("limit", "Daily limit in ETH");
const allowance = field("allowance", "New-payee allowance in ETH");
const delay = field("delay", "Queue delay in seconds");
const cooling = field("cooling", "New-payee cooling in seconds");
const password = field("password", "A password for this browser", "password");
limit.value = "0.1";
allowance.value = "0.01";
delay.value = "86400";
cooling.value = "86400";

const status = h("p", { class: "muted", id: "status" });
const summary = h("div", { class: "card", id: "summary", hidden: true });
const go = h("button", { id: "go", class: "primary", hidden: true }, "Sign and move everything") as HTMLButtonElement;
let planned: { plan: MovePlan; eoa: Address } | null = null;

const say = (text: string) => status.replaceChildren(text);

async function plan() {
  try {
    const linked = (await ask<{ linked: string | null }>({ type: "status" })).linked;
    if (!linked) await ask({ type: "link", url: pairing.value });
    const eoa = privateKeyToAccount(key.value.trim() as Hex).address;
    const list = tokens.value.split(",").map((token) => token.trim()).filter(Boolean).map((token) => getAddress(token));
    const prepared = await ask<{ factory: Address; account: Address; options: Omit<MoveOptions, "stake"> & { stake: string } }>({
      type: "move-plan",
      body: { eoa, harbor: harbor.value.trim(), tokens: list, dailyLimit: limit.value, coolingAllowance: allowance.value, queueDelay: Number(delay.value), coolingPeriod: Number(cooling.value) },
    });
    const options: MoveOptions = { ...prepared.options, stake: BigInt(prepared.options.stake) };
    const config = moveConfig(options);
    // The address comes from the factory on chain, not from the service's word.
    const account = await predictAccount(prepared.factory, config);
    if (account !== prepared.account) throw new Error("the service and the chain disagree about the new address");
    const made = planMove({ factory: prepared.factory, account, config, eoa, holdings: await readHoldings(eoa, list) });
    planned = { plan: made, eoa };
    summary.replaceChildren(
      h("h2", {}, "One transaction"),
      h("div", { id: "plan-from" }, `From ${eoa}, which stays on as the daily key`),
      h("div", { id: "plan-to" }, `To ${account}, a new account`),
      h("div", { id: "plan-eth" }, `${formatEther(made.ether)} ETH${options.stake ? `, of which ${formatEther(options.stake)} is staked by the account` : ""}`),
      ...made.tokens.map((token) => h("div", { "data-token": token.address }, `${token.balance} of ${token.address}`)),
      h("p", { class: "muted" }, "The master key was made by your local service, and stays there. The refund of unused gas stays at the old address."),
    );
    summary.hidden = false;
    go.hidden = false;
    say("Check this, then sign.");
  } catch (error) {
    say((error as Error).message);
  }
}

async function move() {
  if (!planned) return;
  try {
    go.disabled = true;
    const signed = await signDailyTx(planned.plan.tx, key.value.trim() as Hex);
    const trial = await simulate(signed);
    if (trial.executionStatus !== "success" || trial.frames?.some((frame) => !frame.succeeded)) throw new Error(`the move would fail, so it was not sent: ${trial.executionError ?? "a frame failed"}`);
    say("Sent. Waiting for the block…");
    const { hash, receipt } = await submit(signed);
    if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed, so nothing moved`);
    await ask({ type: "move-done", body: { hash } });
    await ask({ type: "import", account: planned.plan.account, key: key.value.trim(), password: password.value });
    key.value = "";
    say(`Moved, in one transaction: ${hash}. Your account is ${planned.plan.account}.`);
    status.setAttribute("data-done", "true");
    go.hidden = true;
  } catch (error) {
    go.disabled = false;
    say((error as Error).message);
  }
}

go.addEventListener("click", () => void move());
root.replaceChildren(
  h("h1", {}, "Move a wallet into a new VAJRA account"),
  h("p", { class: "muted" }, "One transaction creates the account and moves this wallet's ETH and listed tokens into it. The wallet stays on as your daily key, with a limit."),
  pairing,
  key,
  harbor,
  tokens,
  limit,
  allowance,
  delay,
  cooling,
  password,
  h("button", { id: "plan", click: () => void plan() }, "Work out the move"),
  summary,
  go,
  status,
);
