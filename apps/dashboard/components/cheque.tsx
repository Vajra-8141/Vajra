"use client";

import type { QueuedView } from "@vajra/core";
import { countdown, eth, short } from "../lib/format";
import { Stamp } from "./stamp";

const ITEM = { pending: 1, executed: 2, vetoed: 3 };

/** A queued payment is a cheque someone wrote and nobody has cashed. Everything on it comes from the chain. */
export function Cheque({ account, item, now, veto }: { account: string | null; item: QueuedView | null; now: number; veto: { hash: string; gas: number } | null }) {
  if (!item) {
    return (
      <figure className="cheque blank" aria-label="No payment is waiting">
        <div className="cheque-head">
          <span>VAJRA account</span>
          <span className="mono">{account ? short(account) : "no account yet"}</span>
        </div>
        <p className="cheque-empty">No payment is waiting. When a thief goes over the limit, the payment appears here, in public, before any money moves.</p>
      </figure>
    );
  }
  const left = Number(item.executeAfter) - now;
  const waiting = item.state === ITEM.pending;
  return (
    <figure className="cheque" aria-label={`Queued payment, item ${item.id}`}>
      <div className="cheque-head">
        <span>VAJRA account</span>
        <span className="mono">{account ? short(account) : ""}</span>
      </div>
      <div className="cheque-pay">
        <span className="cheque-label">Pay</span>
        <span className="mono cheque-to">{item.recipient}</span>
      </div>
      <div className="cheque-amount">{eth(item.amount)}</div>
      <div className="cheque-foot">
        <span>Signed by the daily key</span>
        <span className="cheque-clock">{waiting ? (left > 0 ? `Leaves in ${countdown(left)}` : "Matured") : item.state === ITEM.vetoed ? "Will never leave" : "Left the account"}</span>
      </div>
      <div className="cheque-micr mono">
        item {item.id.toString()} on chain{veto && item.state === ITEM.vetoed ? `, cancelled by ${short(veto.hash)}` : ""}
      </div>
      <div className="cheque-stamp">
        {item.state === ITEM.vetoed && (
          <Stamp tone="red" sub={veto ? `hash key, ${veto.gas.toLocaleString()} gas` : "hash key"}>
            Cancelled
          </Stamp>
        )}
        {item.state === ITEM.executed && <Stamp tone="green">Paid</Stamp>}
        {waiting && left > 0 && (
          <Stamp tone="violet" sub="public queue" still>
            Waiting
          </Stamp>
        )}
        {waiting && left <= 0 && (
          <Stamp tone="saffron" sub="anyone can execute it" still>
            Matured
          </Stamp>
        )}
      </div>
    </figure>
  );
}
