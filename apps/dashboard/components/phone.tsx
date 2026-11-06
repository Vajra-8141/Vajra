"use client";

import type { QueuedView } from "@vajra/core";
import { countdown, eth, short } from "../lib/format";

/**
 * What the phone would show. It is a stand-in and says so: no message leaves this page. The button is real, though. It asks the
 * bridge for the same veto a tap on the Telegram alert does, and the hash key signs it.
 */
export function Phone({ item, now, busy, onCancel }: { item: QueuedView | null; now: number; busy: boolean; onCancel: () => void }) {
  const waiting = item?.state === 1;
  const left = item ? Number(item.executeAfter) - now : 0;
  return (
    <figure className="phone">
      <div className="phone-screen">
        {waiting ? (
          <div className="phone-alert" role="alert">
            <strong>Was this you?</strong>
            <p>
              {eth(item.amount)} to <span className="mono">{short(item.recipient)}</span>. {left > 0 ? `It leaves in ${countdown(left)} unless you stop it.` : "The delay is over. It can still be cancelled until someone executes it."}
            </p>
            <button className="arc" disabled={busy} aria-busy={busy} onClick={onCancel}>
              {busy ? "Signing with the hash key…" : "Not me, cancel"}
            </button>
          </div>
        ) : (
          <p className="phone-idle">No alerts</p>
        )}
      </div>
      <figcaption className="sub">
        A stand-in, drawn by this page. No message is sent. The real alert comes from <code>vajra watch</code> over Telegram. The button here does the real thing: a hash key veto, mined on the mirror.
      </figcaption>
    </figure>
  );
}
