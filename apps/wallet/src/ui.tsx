/** What every screen shares: the router, the live snapshot, the progress sheet, the hash key sheet, and the small parts. */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import qrcode from "./vendor/qrcode.mjs";
import type { Address, Done, OnStep, QueuedItem, Snapshot } from "./engine-types";
import { engine } from "./wallet";

// --- routing

export function useRoute(): string {
  const read = () => location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
export const go = (path: string) => {
  location.hash = path;
};

// --- words and numbers

export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const isAddr = (a: string): a is Address => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const isAmount = (a: string) => /^\d*\.?\d+$/.test(a.trim()) && Number(a) > 0;

/** ETH as a person reads it: at most six decimals, no trailing noise. */
export function eth(value: string | null): string {
  if (value === null) return "unknown";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} second${Math.round(seconds) === 1 ? "" : "s"}`;
  if (seconds < 5400) {
    const m = Math.round(seconds / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (seconds < 129600) {
    const h = Math.round(seconds / 3600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(seconds / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Turns what the machine said into what a person can act on. The original stays available under Details. */
export function plainError(e: unknown): { title: string; what: string; raw: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.toLowerCase();
  const short = raw.length <= 220;
  if (m.includes("passphrase")) return { title: "Wrong passphrase", what: raw, raw };
  if (m.includes("on your phone") || m.includes("not on this device")) return { title: "The hash key isn't here", what: "Open VAJRA on your phone, where the hash key now lives, and do this there.", raw };
  if (m.includes("used up") || m.includes("no uses left")) return { title: "Hash key used up", what: short ? raw : "Every use is spent. Replace it, or use your recovery paper.", raw };
  if (m.includes("insufficient") || m.includes("more than you have")) return { title: "Not enough ETH", what: "There isn't enough ETH to cover this and its fee. Get test ETH, or try a smaller amount.", raw };
  if (m.includes("can't reach") || m.includes("failed to fetch") || m.includes("fetch failed") || m.includes("networkerror") || m.includes("timed out")) return { title: "Couldn't reach the chain", what: "Check your connection and try again. Nothing was confirmed.", raw };
  if (m.includes("notification") || m.includes("permission")) return { title: "Alerts are blocked", what: short ? raw : "Your browser said no. Allow notifications for this site, then try again.", raw };
  if (m.includes("reverted")) return { title: "The chain refused this", what: "Nothing changed. Check your status on Home, then try again.", raw };
  // The engine already speaks plainly, so its own sentence is the best one. Only a machine-length message gets replaced.
  return { title: "That didn't work", what: short ? raw : "Something went wrong and this was not confirmed.", raw };
}

// --- on-device notes, for the UI's own memory only

export const note = {
  get(k: string) {
    try {
      return localStorage.getItem(`vajra.ui.${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(`vajra.ui.${k}`);
      else localStorage.setItem(`vajra.ui.${k}`, v);
    } catch {
      /* it only costs a hint */
    }
  },
};

// --- the live snapshot

interface Live {
  snap: Snapshot | null;
  error: unknown;
  refresh: () => Promise<void>;
  /** Chain time now, counted on from the last snapshot, or null when the chain's time is unknown. */
  chainNow: () => number | null;
}
const LiveCtx = createContext<Live>({ snap: null, error: null, refresh: async () => {}, chainNow: () => null });
export const useLive = () => useContext(LiveCtx);

export function LiveProvider({ children, active }: { children: ReactNode; active: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const offset = useRef<number | null>(null);
  const running = useRef<Promise<void> | null>(null);

  const read = useCallback(async () => {
    if (engine.state() !== "open") return;
    try {
      const next = await engine.snapshot();
      offset.current = next.chainTime === null ? null : next.chainTime - Date.now() / 1000;
      setSnap(next);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  /** A read already under way may predate the action that asked for this one, so it waits and reads again. */
  const refresh = useCallback(async () => {
    if (running.current) await running.current;
    running.current = read().finally(() => {
      running.current = null;
    });
    await running.current;
  }, [read]);

  useEffect(() => {
    if (!active) {
      setSnap(null);
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (!running.current) void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const value = useMemo(() => ({ snap, error, refresh, chainNow: () => (offset.current === null ? null : Date.now() / 1000 + offset.current) }), [snap, error, refresh]);
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
}

/** Re-renders once a second, for countdowns. */
export function useTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

// --- progress sheet and hash key sheet

export interface ResultView {
  title: string;
  body?: ReactNode;
  done?: Done | null;
  /** The hash key signed this, so the 67 bars are drawn on it. */
  signed?: boolean;
  /** The one moment the bars rise: a payment killed by the hash key. */
  cancelled?: QueuedItem;
  action?: string;
}

interface TaskSpec<T> {
  title: string;
  run: (onStep: OnStep) => Promise<T>;
  /** Left out, the sheet closes on success and the screen shows the result itself. */
  result?: (value: T) => ResultView;
}
interface HashSpec {
  /** What the hash key is about to do, as a sentence. */
  what: string;
  detail?: ReactNode;
  confirm: string;
  /** A word the person must type first. */
  typed?: string;
  /** Exit actions don't spend a hash key signature. */
  noUse?: boolean;
}
interface Tasks {
  /** Resolves with the value on success, and null if it failed and the person closed the sheet. */
  run: <T>(spec: TaskSpec<T>) => Promise<T | null>;
  /** Asks first, then runs. Nothing happens unless the person confirms. */
  hash: <T>(ask: HashSpec, spec: TaskSpec<T>) => Promise<T | null>;
}
const TaskCtx = createContext<Tasks | null>(null);
export const useTasks = () => useContext(TaskCtx) as Tasks;

type Sheet =
  | { kind: "none" }
  | { kind: "ask"; ask: HashSpec; yes: () => void; no: () => void }
  | { kind: "run"; title: string; lines: string[]; failed: ReturnType<typeof plainError> | null; retry: () => void; close: () => void }
  | { kind: "done"; view: ResultView; close: () => void };

export function TaskProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<Sheet>({ kind: "none" });
  const { refresh, snap } = useLive();
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const run = useCallback(
    <T,>(spec: TaskSpec<T>) =>
      new Promise<T | null>((resolve) => {
        const attempt = async () => {
          const lines: string[] = [];
          const close = () => {
            setSheet({ kind: "none" });
            resolve(null);
          };
          const show = (failed: ReturnType<typeof plainError> | null) => setSheet({ kind: "run", title: spec.title, lines: [...lines], failed, retry: () => void attempt(), close });
          show(null);
          try {
            const value = await spec.run((line) => {
              lines.push(line);
              show(null);
            });
            await refresh();
            if (spec.result) setSheet({ kind: "done", view: spec.result(value), close: () => (setSheet({ kind: "none" }), resolve(value)) });
            else {
              setSheet({ kind: "none" });
              resolve(value);
            }
          } catch (e) {
            show(plainError(e));
          }
        };
        void attempt();
      }),
    [refresh],
  );

  const hash = useCallback(
    <T,>(ask: HashSpec, spec: TaskSpec<T>) =>
      new Promise<T | null>((resolve) => {
        setSheet({
          kind: "ask",
          ask,
          no: () => {
            setSheet({ kind: "none" });
            resolve(null);
          },
          yes: () => void run(spec).then(resolve),
        });
      }),
    [run],
  );

  const value = useMemo(() => ({ run, hash }), [run, hash]);
  return (
    <TaskCtx.Provider value={value}>
      {children}
      {sheet.kind !== "none" && <SheetView sheet={sheet} left={snap?.hashKeyLeft ?? null} total={snap?.hashKeyTotal ?? 63} here={snap?.hashKeyHere ?? true} />}
    </TaskCtx.Provider>
  );
}

function SheetView({ sheet, left, total, here }: { sheet: Exclude<Sheet, { kind: "none" }>; left: number | null; total: number; here: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stage = sheet.kind === "run" ? (sheet.failed ? "failed" : "run") : sheet.kind;
  useEffect(() => {
    ref.current?.focus();
  }, [stage]);
  useEffect(() => {
    const dismiss = sheet.kind === "ask" ? sheet.no : sheet.kind === "done" ? sheet.close : sheet.kind === "run" && sheet.failed ? sheet.close : null;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss?.();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [sheet]);

  return (
    <div className="scrim">
      <div className={`sheet ${sheet.kind === "ask" ? "sheet-arc" : ""}`} role="dialog" aria-modal="true" tabIndex={-1} ref={ref} aria-label={sheet.kind === "ask" ? "Hash key" : sheet.kind === "run" ? sheet.title : sheet.view.title}>
        {sheet.kind === "ask" && <AskView sheet={sheet} left={left} total={total} here={here} />}
        {sheet.kind === "run" && (
          <>
            {sheet.failed ? (
              <div className="sheet-head" role="alert">
                <h2 className="danger-text">{sheet.failed.title}</h2>
                <p className="t60">{sheet.failed.what}</p>
              </div>
            ) : (
              <div className="sheet-head">
                <h2>{sheet.title}</h2>
              </div>
            )}
            <Steps lines={sheet.lines} failed={!!sheet.failed} />
            {sheet.failed ? (
              <>
                {sheet.failed.raw !== sheet.failed.what && (
                  <details className="proof">
                    <summary>Details</summary>
                    <p className="mono">{sheet.failed.raw}</p>
                  </details>
                )}
                <div className="stack">
                  <button className="btn primary" onClick={sheet.retry}>
                    Try again
                  </button>
                  <button className="btn" onClick={sheet.close}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <p className="t40 small">This takes a few seconds. Keep this screen open.</p>
            )}
          </>
        )}
        {sheet.kind === "done" && (
          <>
            <div className="sheet-head" role="status">
              <div className="row-tight">
                {!sheet.view.cancelled && <Tick />}
                <h2>{sheet.view.title}</h2>
              </div>
              {sheet.view.body && <div className="t60">{sheet.view.body}</div>}
            </div>
            {sheet.view.cancelled && <CancelMoment item={sheet.view.cancelled} hash={sheet.view.done?.hash ?? ""} />}
            {sheet.view.signed && !sheet.view.cancelled && sheet.view.done && <Bars hash={sheet.view.done.hash} still />}
            {sheet.view.done && <Proof done={sheet.view.done} />}
            <button className="btn primary" onClick={sheet.close}>
              {sheet.view.action ?? "Done"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AskView({ sheet, left, total, here }: { sheet: Extract<Sheet, { kind: "ask" }>; left: number | null; total: number; here: boolean }) {
  const [typed, setTyped] = useState("");
  const { ask } = sheet;
  const spent = left === 0 && !ask.noUse;
  const away = !here && !ask.noUse;
  const ready = !spent && !away && (!ask.typed || typed.trim().toUpperCase() === ask.typed);
  return (
    <>
      <div className="sheet-head">
        <p className="arc-text small">{ask.noUse ? "Second way out" : "Your hash key is about to"}</p>
        <h2>{ask.what}</h2>
        {ask.detail && <div className="t60">{ask.detail}</div>}
      </div>
      {away ? (
        <p className="note-warn">Your hash key is on your phone. Open VAJRA there to do this.</p>
      ) : spent ? (
        <p className="note-danger">Your hash key has no uses left. Use your recovery paper to take back the account.</p>
      ) : (
        !ask.noUse && (
          <p className="t60 small">
            {left === null ? "Uses left: unknown." : `This uses 1 of its ${left} uses left, out of ${total}.`} A hash key signature works once, which is what makes it safe from quantum computers.
          </p>
        )
      )}
      {ask.typed && !away && !spent && (
        <label className="field">
          <span>Type {ask.typed} to confirm</span>
          <input autoCapitalize="characters" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      <div className="stack">
        <button className="btn arc" disabled={!ready} onClick={sheet.yes}>
          {ask.confirm}
        </button>
        <button className="btn" onClick={sheet.no}>
          Not now
        </button>
      </div>
    </>
  );
}

export function Steps({ lines, failed }: { lines: string[]; failed?: boolean }) {
  return (
    <ol className="steps" aria-live="polite">
      {lines.length === 0 && !failed && (
        <li className="now">
          <Spin /> Starting
        </li>
      )}
      {lines.map((line, i) => {
        const last = i === lines.length - 1;
        return (
          <li key={i} className={last ? (failed ? "bad" : "now") : "past"}>
            {last ? failed ? <Cross /> : <Spin /> : <Tick small />}
            <span>{line}</span>
          </li>
        );
      })}
    </ol>
  );
}

// --- small parts

export const Spin = () => <span className="spin" aria-hidden />;
export const Tick = ({ small }: { small?: boolean }) => (
  <svg className={`tick ${small ? "tick-s" : ""}`} viewBox="0 0 16 16" aria-hidden>
    <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const Cross = () => (
  <svg className="tick tick-s cross" viewBox="0 0 16 16" aria-hidden>
    <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);

export function Proof({ done }: { done: Done }) {
  return (
    <details className="proof">
      <summary>Proof</summary>
      <dl>
        <dt>Transaction</dt>
        <dd>
          <a className="mono" href={done.explorer} target="_blank" rel="noreferrer">
            {short(done.hash)}
          </a>
        </dd>
        <dt>Block</dt>
        <dd>{done.block.toLocaleString("en-US")}</dd>
        <dt>Gas to verify</dt>
        <dd>{done.verifyGas === null ? "not recorded" : done.verifyGas.toLocaleString("en-US")}</dd>
        {done.arkiv && (
          <>
            <dt>Public key record</dt>
            <dd>
              <a href={done.arkiv} target="_blank" rel="noreferrer">
                On Arkiv
              </a>
            </dd>
          </>
        )}
      </dl>
      {done.canonicalRefusal ? (
        <div className="refusal">
          <p className="t60 small">The normal way in would have refused this. In its own words:</p>
          <p className="mono">{done.canonicalRefusal}</p>
          <p className="t60 small">So this went through the second way in, which is why your hash key always gets through.</p>
        </div>
      ) : (
        <p className="t60 small">The normal way in would have taken this too.</p>
      )}
    </details>
  );
}

const CHAINS = 67;
function chainLevels(hash: string): number[] {
  const digits = hash.replace(/^0x/, "").padEnd(64, "0").slice(0, 64).split("").map((d) => parseInt(d, 16) || 0);
  const checksum = digits.reduce((sum, d) => sum + (15 - d), 0);
  return [...digits, (checksum >> 8) & 15, (checksum >> 4) & 15, checksum & 15];
}

/** The hash key's one visual, drawn from the transaction's hash the way a hash key picks its chains. It only ever appears where the hash key signed. */
export function Bars({ hash, still }: { hash: string; still?: boolean }) {
  return (
    <figure className={`bars ${still ? "still" : ""}`}>
      <svg viewBox={`0 0 ${CHAINS * 3} 32`} preserveAspectRatio="none" aria-hidden>
        {chainLevels(hash).map((level, i) => (
          <rect key={i} x={i * 3} y={32 - (level + 1) * 2} width="2" height={(level + 1) * 2} style={{ animationDelay: `${i * 4}ms` }} />
        ))}
      </svg>
      <figcaption>A picture drawn from this transaction, not the signature itself.</figcaption>
    </figure>
  );
}

/** The hash key outranking the wallet key. The struck payment and the 67 bars happen here and nowhere else. */
export function CancelMoment({ item, hash }: { item: QueuedItem; hash: string }) {
  return (
    <div className="cancel">
      <div className="cancel-row">
        <div>
          <p className="cancel-amount">
            <span>{eth(item.amount)} ETH</span>
          </p>
          <p className="t60 small">
            to <span className="mono">{short(item.to)}</span>
          </p>
        </div>
        <span className="stamp">Cancelled</span>
      </div>
      <Bars hash={hash} />
    </div>
  );
}

export function Qr({ text, label }: { text: string; label: string }) {
  const drawn = useMemo(() => {
    try {
      const q = qrcode(0, "M");
      q.addData(text);
      q.make();
      const n = q.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { n, d };
    } catch {
      return null;
    }
  }, [text]);
  if (!drawn) return <p className="note-warn">This is too long for a QR code. Use the copy button instead.</p>;
  return (
    <div className="qr">
      <svg viewBox={`-3 -3 ${drawn.n + 6} ${drawn.n + 6}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <path d={drawn.d} fill="var(--base)" />
      </svg>
    </div>
  );
}

export function Copy({ text, label = "Copy", className = "btn" }: { text: string; label?: string; className?: string }) {
  const [state, set] = useState<"idle" | "ok" | "bad">("idle");
  return (
    <button
      className={className}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => set("ok"))
          .catch(() => set("bad"))
          .finally(() => setTimeout(() => set("idle"), 1800));
      }}
    >
      {state === "ok" ? "Copied" : state === "bad" ? "Press and hold the text to copy" : label}
    </button>
  );
}

export function AddressInput({ value, onChange, label = "To", placeholder = "0x…" }: { value: string; onChange: (v: string) => void; label?: string; placeholder?: string }) {
  const bad = value.trim() !== "" && !isAddr(value);
  const canPaste = typeof navigator !== "undefined" && !!navigator.clipboard?.readText;
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-with">
        <input id={id} className="mono-input" inputMode="text" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value.trim())} aria-invalid={bad} />
        {canPaste && (
          <button type="button" className="inline-btn" onClick={() => void navigator.clipboard.readText().then((t) => onChange(t.trim()), () => {})}>
            Paste
          </button>
        )}
      </div>
      {bad && <small className="danger-text">That doesn't look like an address. It starts with 0x and has 42 characters.</small>}
    </div>
  );
}

export function Screen({ title, back, children, lead }: { title: string; back?: string; children: ReactNode; lead?: ReactNode }) {
  return (
    <section className="screen">
      <header className="screen-head">
        {back && (
          <a className="back" href={`#${back}`} aria-label="Back">
            <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden>
              <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
        <h1>{title}</h1>
      </header>
      {lead && <p className="lead">{lead}</p>}
      {children}
    </section>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="state" role="status">
      <Spin />
      <p className="t60">{what}</p>
    </div>
  );
}

export function Failed({ e, retry }: { e: unknown; retry?: () => void }) {
  const p = plainError(e);
  return (
    <div className="state state-bad" role="alert">
      <h2>{p.title}</h2>
      <p className="t60">{p.what}</p>
      {retry && (
        <button className="btn" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** A screen that needs the snapshot: loading and error come for free. */
export function WithSnap({ children }: { children: (s: Snapshot) => ReactNode }) {
  const { snap, error, refresh } = useLive();
  if (snap) return <>{children(snap)}</>;
  if (error) return <Failed e={error} retry={() => void refresh()} />;
  return <Loading what="Reading your account from the chain" />;
}

export function download(name: string, text: string) {
  // An app on an iPhone home screen can't save a download, so the share sheet does it: Save to Files.
  if (/iPhone|iPad/.test(navigator.userAgent)) {
    const file = new File([text], name, { type: "text/plain" });
    if (navigator.canShare?.({ files: [file] })) {
      void navigator.share({ files: [file] }).catch(() => {});
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function Limit({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const presets = ["0.01", "0.02", "0.05", "0.1"];
  return (
    <div className="limit">
      <p className="figure">
        {value} <span>ETH a day</span>
      </p>
      <input type="range" aria-label="Daily limit in ETH" min={0.005} max={0.2} step={0.005} value={Number(value)} onChange={(e) => onChange(String(Number(Number(e.target.value).toFixed(3))))} />
      <div className="chips">
        {presets.map((p) => (
          <button key={p} type="button" className={`chip ${Number(value) === Number(p) ? "on" : ""}`} aria-pressed={Number(value) === Number(p)} onClick={() => onChange(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

export const DELAYS = [
  { s: 60, label: "1 minute", hint: "For trying it" },
  { s: 120, label: "2 minutes", hint: "Long enough to see it work" },
  { s: 3600, label: "1 hour", hint: "For everyday money" },
  { s: 86400, label: "1 day", hint: "For money you rarely move" },
];

export function DelayPicker({ value, onChange }: { value: number; onChange: (s: number) => void }) {
  return (
    <div className="options" role="radiogroup" aria-label="How long a payment waits">
      {DELAYS.map((d) => (
        <button key={d.s} type="button" role="radio" aria-checked={value === d.s} className={`option ${value === d.s ? "on" : ""}`} onClick={() => onChange(d.s)}>
          <span>{d.label}</span>
          <small>{d.hint}</small>
        </button>
      ))}
    </div>
  );
}

/** A passphrase field with an honest strength hint: length matters most. */
export function strength(p: string): { score: 0 | 1 | 2 | 3; word: string } {
  if (!p) return { score: 0, word: "" };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(p)).length;
  const words = p.trim().split(/\s+/).length;
  if (p.length < 8) return { score: 1, word: "Too short. Use at least 8 characters." };
  if (p.length >= 16 || (p.length >= 12 && kinds >= 3) || words >= 4) return { score: 3, word: "Strong" };
  if (p.length >= 12 || kinds >= 3) return { score: 2, word: "Fine. A few more words would make it strong." };
  return { score: 1, word: "Weak. Try three or four random words." };
}
