/** Home, the queue card, and the page a push opens. */
import { useEffect, useState } from "react";
import type { QueuedItem, Snapshot } from "../engine-types";
import { engine } from "../wallet";
import { clock, Copy, eth, go, note, Screen, short, useLive, useTasks, useTick, WithSnap } from "../ui";
import { nextStep } from "./protection";

export function statusOf(s: Snapshot): { word: string; tone: "ok" | "warn" | "danger" | "unknown"; line: string } {
  if (s.escaped) return { word: "Escaped", tone: "danger", line: "Everything moved to your safe." };
  if (s.queue && s.queue.length > 0) return { word: "Payment waiting", tone: "warn", line: s.queue.length > 1 ? `${s.queue.length} payments are waiting in public.` : "A payment is waiting in public." };
  if (s.frozen) return { word: "Frozen", tone: "warn", line: "Nothing can leave until you unfreeze." };
  if (s.frozen === null || s.escaped === null || s.queue === null) return { word: "Status unknown", tone: "unknown", line: "The chain can't be read right now." };
  return { word: "Protected", tone: "ok", line: "Your hash key outranks your wallet key." };
}

export function useNotMe() {
  const { hash } = useTasks();
  return (item: QueuedItem, onDone?: (d: Awaited<ReturnType<typeof engine.notMe>>) => void, quiet?: boolean) =>
    hash(
      {
        what: item.isRecovery ? "Stop this recovery" : `Cancel ${eth(item.amount)} ETH`,
        detail: item.isRecovery ? "Someone used your recovery paper. Stopping it keeps your account yours." : <>It was going to <span className="mono">{short(item.to)}</span>. It will never be paid.</>,
        confirm: item.isRecovery ? "Stop recovery" : "Cancel this payment",
      },
      {
        title: "Cancelling",
        run: (s) => engine.notMe(item.id, s),
        result: quiet ? undefined : (d) => ({ title: item.isRecovery ? "Recovery stopped" : "Your hash key killed that payment", body: "The wallet key can't get past it.", done: d, signed: true, cancelled: item }),
      },
    ).then((d) => {
      if (d) onDone?.(d);
      return d;
    });
}

export function QueueCard({ item, snap, onNotMe }: { item: QueuedItem; snap: Snapshot; onNotMe?: () => void }) {
  const { chainNow } = useLive();
  const { hash, run } = useTasks();
  const notMe = useNotMe();
  useTick();
  const now = chainNow();
  const left = now === null ? null : item.executeAfter - now;
  const due = left !== null && left <= 0;
  const hashHere = snap.hashKeyHere;
  const title = item.isRecovery ? (item.unknownToThisDevice ? "Someone is recovering your account" : "Your recovery is waiting") : item.unknownToThisDevice ? "Did you do this?" : "Your payment is waiting";

  if (item.isRecovery && !item.unknownToThisDevice)
    return (
      <article className="queue">
        <div className="queue-top">
          <h2>{title}</h2>
          <p className="queue-time">{left === null ? "unknown" : due ? "0:00" : clock(left)}</p>
        </div>
        <a className="btn primary" href="#/recovering">
          See recovery
        </a>
      </article>
    );

  return (
    <article className="queue" aria-label={title}>
      <div className="queue-top">
        <div>
          <h2>{title}</h2>
          {!item.isRecovery && <p className="queue-amount">{eth(item.amount)} ETH</p>}
          <p className="t60 small">{item.isRecovery ? "Someone used your recovery paper. If it wasn't you, stop it now." : <>to <span className="mono">{short(item.to)}</span></>}</p>
        </div>
        <div className="queue-clock">
          <p className="queue-time" role="timer">
            {left === null ? "unknown" : due ? "0:00" : clock(left)}
          </p>
          <p className="t60 small">{left === null ? "time left" : due ? "wait is over" : "left to stop it"}</p>
        </div>
      </div>
      {due && <p className="t60 small">The wait is over, so anyone can finish this now. Cancel it first if it isn't you.</p>}
      {!hashHere && <p className="t60 small">Your hash key is on your phone. Answer this in VAJRA there.</p>}
      <div className="queue-actions">
        <button className="btn arc" disabled={!hashHere} onClick={() => (onNotMe ? onNotMe() : void notMe(item))}>
          Not me
        </button>
        {due && !item.isRecovery ? (
          <button
            className="btn"
            onClick={() =>
              void run({
                title: "Finishing the payment",
                run: (s) => engine.finishQueued(item.id, s),
                result: (d) => ({ title: "Paid", body: `${eth(item.amount)} ETH went to ${short(item.to)}.`, done: d }),
              })
            }
          >
            Finish payment
          </button>
        ) : (
          !item.isRecovery && (
            <button
              className="btn"
              disabled={!hashHere}
              onClick={() =>
                void hash(
                  { what: `Pay ${eth(item.amount)} ETH now`, detail: <>Skips the wait and pays <span className="mono">{short(item.to)}</span>.</>, confirm: "Pay now" },
                  { title: "Paying", run: (s) => engine.payNow(item.id, s), result: (d) => ({ title: "Paid", body: `${eth(item.amount)} ETH went to ${short(item.to)}.`, done: d, signed: true }) },
                )
              }
            >
              Pay, it's me
            </button>
          )
        )}
      </div>
    </article>
  );
}

function InstallHint() {
  const [hidden, setHidden] = useState(() => note.get("installHidden") === "1");
  const [prompt, setPrompt] = useState<(Event & { prompt: () => Promise<void> }) | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setPrompt(e as Event & { prompt: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);
  const ua = navigator.userAgent;
  const iphone = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1);
  const phone = iphone || /Android|Mobile/.test(ua);
  const installed = matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (hidden || !phone || installed) return null;
  return (
    <aside className="hint">
      <div>
        <h2>Add VAJRA to your Home Screen</h2>
        {iphone ? (
          <p className="t60 small">In Safari, tap Share, then Add to Home Screen. On iPhone, push alerts only work once it's there.</p>
        ) : (
          <p className="t60 small">{prompt ? "It opens like an app, and alerts reach you faster." : "Open your browser's menu, then tap Add to Home screen."}</p>
        )}
        {prompt && (
          <button className="text-btn" onClick={() => void prompt.prompt().then(() => setPrompt(null))}>
            Install
          </button>
        )}
      </div>
      <button
        className="x"
        aria-label="Dismiss"
        onClick={() => {
          note.set("installHidden", "1");
          setHidden(true);
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </aside>
  );
}

function Meter({ s }: { s: Snapshot }) {
  if (s.dailyLeft === null || s.dailyLimit === null)
    return (
      <div className="today">
        <p className="t60 small">Left today: unknown</p>
      </div>
    );
  const pct = Math.max(0, Math.min(100, (Number(s.dailyLeft) / (Number(s.dailyLimit) || 1)) * 100));
  return (
    <div className="today">
      <div className="today-row">
        <span>{eth(s.dailyLeft)} ETH left today</span>
        <span className="t60">of {eth(s.dailyLimit)}</span>
      </div>
      <div className="meter" role="img" aria-label={`${eth(s.dailyLeft)} of ${eth(s.dailyLimit)} ETH left today`}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Home() {
  const { run, hash } = useTasks();
  return (
    <WithSnap>
      {(s) => {
        const st = statusOf(s);
        const low = s.balance !== null && Number(s.balance) < 0.004;
        const empty = s.balance !== null && Number(s.balance) === 0;
        const next = nextStep(s);
        const topUp = () => void run({ title: "Getting test ETH", run: (x) => engine.topUp(x), result: () => ({ title: "Test ETH arrived", body: "It's in your wallet now." }) });
        const unfreeze = () => void hash({ what: "Unfreeze your wallet", detail: "Your wallet key can spend again.", confirm: "Unfreeze" }, { title: "Unfreezing", run: (x) => engine.unfreeze(x), result: (d) => ({ title: "Unfrozen", body: "Your wallet key works again.", done: d, signed: true }) });
        return (
          <section className="screen home">
            <div className="hero">
              <p className={`status tone-${st.tone}`}>
                <i />
                {st.word}
              </p>
              <p className={`balance ${s.balance === null ? "is-unknown" : ""}`}>
                {s.balance === null ? (
                  "Unknown"
                ) : (
                  <>
                    {eth(s.balance)} <span>ETH</span>
                  </>
                )}
              </p>
              <p className="t60">{s.balance === null ? "Your balance can't be read right now." : st.line}</p>
            </div>

            {s.queue?.map((item) => <QueueCard key={item.id} item={item} snap={s} />)}

            {s.escaped ? (
              <a className="btn primary" href="#/safe">
                Open your safe
              </a>
            ) : (
              <>
                <Meter s={s} />
                <div className="actions">
                  {s.frozen ? (
                    <button className="btn arc" onClick={unfreeze}>
                      Unfreeze
                    </button>
                  ) : empty ? (
                    <button className="btn primary" onClick={topUp}>
                      Get test ETH
                    </button>
                  ) : s.walletKeyHere ? (
                    <a className="btn primary" href="#/send">
                      Send
                    </a>
                  ) : null}
                  <a className="btn" href="#/receive">
                    Receive
                  </a>
                </div>
                {low && !empty && (
                  <button className="text-btn" onClick={topUp}>
                    Running low. Get test ETH
                  </button>
                )}
              </>
            )}

            <InstallHint />

            {next && !s.escaped && (
              <a className="nextup" href="#/protection">
                <div>
                  <small>Next for your protection</small>
                  <strong>{next.title}</strong>
                  <p className="t60 small">{next.danger}</p>
                </div>
                <Chevron />
              </a>
            )}
            {!next && !s.escaped && (
              <a className="nextup" href="#/pool">
                <div>
                  <small>Your wallet is fully protected</small>
                  <strong>Private pool</strong>
                  <p className="t60 small">Every payment here is public. The pool breaks the link between where money came from and where it goes.</p>
                </div>
                <Chevron />
              </a>
            )}
            <div className="account-line">
              <span className="t60 small">Your address</span>
              <Copy className="addr-copy" text={s.account} label={short(s.account)} />
            </div>
          </section>
        );
      }}
    </WithSnap>
  );
}

export const Chevron = () => (
  <svg className="chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
    <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Where a push lands. */
export function Queue() {
  return (
    <Screen title="Waiting in public" back="/">
      <WithSnap>
        {(s) =>
          s.queue === null ? (
            <p className="note-warn">The queue can't be read right now, so it's unknown. Don't assume it's empty.</p>
          ) : s.queue.length === 0 ? (
            <div className="state">
              <h2>Nothing is waiting</h2>
              <p className="t60">If a payment was here, it finished or was cancelled. Activity has the full story.</p>
              <button className="btn" onClick={() => go("/activity")}>
                See activity
              </button>
            </div>
          ) : (
            s.queue.map((item) => <QueueCard key={item.id} item={item} snap={s} />)
          )
        }
      </WithSnap>
    </Screen>
  );
}
