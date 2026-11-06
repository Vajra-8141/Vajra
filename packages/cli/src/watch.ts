/**
 * Watches the public queue and asks the owner, on Telegram, whether a payment is really theirs.
 *
 * Only outbound connections: this polls Telegram and the chain, so nothing on this machine opens to the network, and the bridge
 * stays on loopback. A button can only ask for two things, and neither is signed here without the checks below:
 *
 *   Not me         cancels the item, with the master key.
 *   Pay, it's me   sends it now, with the master key. On a software signer that would make a phone tap enough to move money, so
 *                  a stolen phone plus a stolen daily key could empty the account. So it needs the hardware signer, whose button
 *                  is a second factor, unless --allow-software-pay says otherwise.
 *
 * Telegram sees what these alerts say. That is fine for a demo, and it is why this is off unless a token is set.
 */
import { type Address, formatEther } from "viem";
import { ETH, accountV2Abi, deployments, publicClient, readAccount } from "@vajra/core";
import { type MasterResult, requireWallet, runMasterOp } from "./wallet.ts";

export type Button = { action: "veto" | "pay"; id: bigint };

/** Exactly what the alert's buttons send. Anything else did not come from them. */
export function parseButton(data: string | undefined): Button | null {
  const match = /^(veto|pay):(\d{1,18})$/.exec(data ?? "");
  return match ? { action: match[1] as Button["action"], id: BigInt(match[2]!) } : null;
}

export interface Tap {
  /** Who pressed, as Telegram reports it. */
  from: number;
  data: string | undefined;
}

export type Decision = { ok: true; button: Button } | { ok: false; reason: string };

/** Everything that has to be true before a tap may reach the master key. Pending ids come from the chain, not from the message. */
export function decide(tap: Tap, o: { owner: number; pending: Set<bigint>; recoveries: Set<bigint>; hardware: boolean; allowSoftwarePay: boolean }): Decision {
  if (tap.from !== o.owner) return { ok: false, reason: "This account is not the owner." };
  const button = parseButton(tap.data);
  if (!button) return { ok: false, reason: "That button was not one of ours." };
  if (!o.pending.has(button.id)) return { ok: false, reason: `Item ${button.id} is no longer waiting.` };
  if (button.action === "pay") {
    if (o.recoveries.has(button.id)) return { ok: false, reason: "A new key tree cannot be released early: it has to wait out the delay." };
    if (!o.hardware && !o.allowSoftwarePay) return { ok: false, reason: "Pay needs the hardware signer, so that a phone alone cannot move money." };
  }
  return { ok: true, button };
}

export interface Alert {
  id: bigint;
  recipient: Address;
  asset: Address;
  amount: bigint;
  secondsLeft: number;
  recovery: boolean;
}

export function alertMessage(a: Alert) {
  const left = a.secondsLeft > 0 ? `${Math.ceil(a.secondsLeft / 60)} min` : "now";
  if (a.recovery) {
    return {
      text: `Someone is replacing your master key with a recovery proof. It takes effect in ${left}. Was this you?`,
      buttons: [{ text: "Not me, cancel", callback_data: `veto:${a.id}` }],
    };
  }
  const what = a.asset === ETH ? `${formatEther(a.amount)} ETH` : `${a.amount} of token ${a.asset}`;
  return {
    text: `${what} to ${a.recipient}. It leaves in ${left} unless you stop it. Was this you?`,
    buttons: [
      { text: "Not me, cancel", callback_data: `veto:${a.id}` },
      { text: "Pay, it's me", callback_data: `pay:${a.id}` },
    ],
  };
}

const API = process.env.TELEGRAM_API ?? "https://api.telegram.org";

async function telegram<T>(token: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
  const reply = (await response.json()) as { ok: boolean; result: T; description?: string };
  if (!reply.ok) throw new Error(`Telegram ${method}: ${reply.description ?? response.status}`);
  return reply.result;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number } };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads the queue from the chain. A failed read throws: an unknown queue must never look like an empty one. */
export async function readQueue(account: Address) {
  const view = await readAccount(account);
  const items = view.items.filter((item) => item.state === 1);
  const recoveries = new Set<bigint>();
  if (deployments().v2) {
    for (const item of items) {
      const recovery = await publicClient.readContract({ address: account, abi: accountV2Abi as never, functionName: "isRecovery", args: [item.id] } as never);
      if (recovery) recoveries.add(item.id);
    }
  }
  return { items, recoveries };
}

export async function watch(o: { allowSoftwarePay: boolean }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("put TELEGRAM_BOT_TOKEN in .env: make a bot with @BotFather");
  const ownerText = process.env.TELEGRAM_CHAT_ID;
  let offset = 0;

  if (!ownerText) {
    console.log("No TELEGRAM_CHAT_ID yet. Send /start to your bot, and your id will appear here.");
    for (;;) {
      const updates = await telegram<Update[]>(token, "getUpdates", { offset, timeout: 25 });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          console.log(`Put this in .env, then start again:\n\nTELEGRAM_CHAT_ID=${update.message.chat.id}\n`);
          return;
        }
      }
    }
  }

  const owner = Number(ownerText);
  if (!Number.isSafeInteger(owner)) throw new Error("TELEGRAM_CHAT_ID is not a number");
  const { account } = requireWallet();
  const hardware = process.env.VAJRA_SIGNER === "device";
  if (!hardware && o.allowSoftwarePay) console.log("WARNING: Pay is on with a software signer. A phone tap alone can now move money.");
  console.log(`watching ${account}\nsigner: ${hardware ? "hardware" : "software"}, Pay ${hardware || o.allowSoftwarePay ? "on" : "off"}`);

  // Nothing tapped before this run is acted on: an old button must not fire because the watcher came back.
  const stale = await telegram<Update[]>(token, "getUpdates", { offset: -1, timeout: 0 });
  offset = (stale.at(-1)?.update_id ?? -1) + 1;

  const alerted = new Set<bigint>();
  for (;;) {
    try {
      const { items, recoveries } = await readQueue(account);
      const now = Number((await publicClient.getBlock()).timestamp);
      for (const item of items) {
        if (alerted.has(item.id)) continue;
        const { text, buttons } = alertMessage({ ...item, secondsLeft: Number(item.executeAfter) - now, recovery: recoveries.has(item.id) });
        await telegram(token, "sendMessage", { chat_id: owner, text, reply_markup: { inline_keyboard: [buttons] } });
        alerted.add(item.id);
        console.log(`alerted: item ${item.id}`);
      }

      const updates = await telegram<Update[]>(token, "getUpdates", { offset, timeout: 2, allowed_updates: ["callback_query"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        const query = update.callback_query;
        if (!query) continue;
        // Read again at the moment of the tap: a queue from before the long poll could be out of date.
        const fresh = await readQueue(account);
        const decision = decide(
          { from: query.from.id, data: query.data },
          { owner, pending: new Set(fresh.items.map((item) => item.id)), recoveries: fresh.recoveries, hardware, allowSoftwarePay: o.allowSoftwarePay },
        );
        if (!decision.ok) {
          console.log(`refused a tap from ${query.from.id}: ${decision.reason}`);
          await telegram(token, "answerCallbackQuery", { callback_query_id: query.id, text: decision.reason, show_alert: true });
          continue;
        }
        const { action, id } = decision.button;
        await telegram(token, "answerCallbackQuery", { callback_query_id: query.id, text: hardware ? "Check the signer's screen and press BOOT" : "Signing with the hash key" });
        console.log(`${action} of item ${id}, asked by the owner`);
        let result: MasterResult;
        try {
          result = await runMasterOp({ op: action, id: id.toString() }, console.log);
        } catch (error) {
          console.log(`failed: ${(error as Error).message}`);
          await telegram(token, "sendMessage", { chat_id: owner, text: `That did not go through: ${(error as Error).message.slice(0, 300)}` });
          continue;
        }
        const done = action === "veto" ? `Cancelled item ${id}.` : `Paid item ${id}.`;
        await telegram(token, "sendMessage", { chat_id: owner, text: `${done} Signed by the hash key, in block ${result.block}.` });
        console.log(`${done} ${result.hash}`);
      }
    } catch (error) {
      // A bad network must not end the watch: this is the one process that has to stay up during a theft.
      console.log(`watch: ${(error as Error).message}`);
      await sleep(3000);
    }
  }
}
