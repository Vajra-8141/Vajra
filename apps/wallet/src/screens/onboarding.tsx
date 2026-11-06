/** Everything before Home: welcome, create, the mandatory backup, lock, restore, recover, and the phone's side of moving the hash key. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Address, Done } from "../engine-types";
import { engine } from "../wallet";
import { AddressInput, clock, DelayPicker, download, Failed, go, isAddr, Limit, Loading, note, plainError, Proof, Screen, Spin, Steps, strength, Tick, useLive, useTasks, useTick } from "../ui";

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden>
      <path d="M13.5 2 5 13.5h5.5L9.5 22 19 9.5h-6L13.5 2Z" fill="currentColor" />
    </svg>
  );
}
export const Brand = () => (
  <span className="brand">
    <Mark /> VAJRA
  </span>
);

export function Welcome() {
  // Safari and the home screen app keep separate storage, so a wallet made in Safari would not be in the app.
  const iphoneInBrowser = /iPhone|iPad/.test(navigator.userAgent) && (navigator as unknown as { standalone?: boolean }).standalone !== true;
  return (
    <section className="welcome">
      <Brand />
      <div className="welcome-mark" aria-hidden>
        <svg viewBox="0 0 24 24">
          <path d="M13.5 2 5 13.5h5.5L9.5 22 19 9.5h-6L13.5 2Z" fill="currentColor" />
        </svg>
      </div>
      <div className="welcome-body">
        <h1>A wallet a thief can't empty, even with your key.</h1>
        <p className="lead">Small payments go straight through. Big ones wait in public, and a second key can stop them.</p>
      </div>
      {iphoneInBrowser && <p className="note-warn">On iPhone, first tap Share, then Add to Home Screen, and open VAJRA from there. A wallet made in Safari stays in Safari, and alerts only work in the app.</p>}
      <div className="stack">
        <a className="btn primary" href="#/create">
          Create a wallet
        </a>
        <a className="btn" href="#/restore">
          Restore from backup
        </a>
        <a className="btn quiet" href="#/recover">
          Recover with paper
        </a>
      </div>
    </section>
  );
}

function PassphraseFields({ value, confirm, onValue, onConfirm, label = "Passphrase" }: { value: string; confirm: string; onValue: (v: string) => void; onConfirm: (v: string) => void; label?: string }) {
  const st = strength(value);
  const mismatch = confirm !== "" && confirm !== value;
  return (
    <>
      <label className="field">
        <span>{label}</span>
        <input type="password" autoComplete="new-password" value={value} onChange={(e) => onValue(e.target.value)} />
        <div className="meter-4" data-score={st.score} aria-hidden>
          <i />
          <i />
          <i />
        </div>
        {st.word && <small>{st.word}</small>}
      </label>
      <label className="field">
        <span>Type it again</span>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => onConfirm(e.target.value)} aria-invalid={mismatch} />
        {mismatch && <small className="danger-text">These don't match yet.</small>}
      </label>
    </>
  );
}

export function Create({ onMade }: { onMade: () => void }) {
  const [step, setStep] = useState(0);
  const [limit, setLimit] = useState("0.02");
  const [delay, setDelay] = useState(120);
  const [own, setOwn] = useState(false);
  const [safe, setSafe] = useState("");
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [failed, setFailed] = useState<unknown>(null);

  const make = async () => {
    setStep(4);
    setLines([]);
    setFailed(null);
    note.set("backupPending", "1");
    try {
      await engine.create({ passphrase: pass, dailyLimit: limit, delaySeconds: delay, safe: own ? (safe as Address) : null }, (line) => setLines((l) => [...l, line]));
      onMade();
    } catch (e) {
      note.set("backupPending", null);
      setFailed(e);
    }
  };

  if (step === 4) {
    const p = failed ? plainError(failed) : null;
    return (
      <section className="flow">
        <div className="flow-body">
          <h1>{p ? p.title : "Making your wallet"}</h1>
          <p className="lead">{p ? p.what : "Two keys and a safe, and your account goes on the chain. Your keys are made here, on this device."}</p>
          <Steps lines={lines} failed={!!p} />
        </div>
        {p ? (
          <div className="stack">
            <button className="btn primary" onClick={() => void make()}>
              Try again
            </button>
            <button className="btn" onClick={() => setStep(3)}>
              Change my answers
            </button>
          </div>
        ) : (
          <p className="t40 small">This takes a few seconds. Keep this screen open.</p>
        )}
      </section>
    );
  }

  const pages = [
    {
      title: "How much can go out without asking?",
      lead: "Your wallet key spends up to this each day on its own. It's your everyday key.",
      body: <Limit value={limit} onChange={setLimit} />,
      ok: true,
    },
    {
      title: "How long should a bigger payment wait?",
      lead: "Anything over your limit waits in public for this long. That's your time to stop it.",
      body: <DelayPicker value={delay} onChange={setDelay} />,
      ok: true,
    },
    {
      title: "Where should your money run to?",
      lead: "If you ever have to escape, everything moves to your safe in one go.",
      body: (
        <>
          <div className="options" role="radiogroup" aria-label="Your safe">
            <button type="button" role="radio" aria-checked={!own} className={`option ${!own ? "on" : ""}`} onClick={() => setOwn(false)}>
              <span>Make one for me</span>
              <small>A new address, with its key kept in this wallet</small>
            </button>
            <button type="button" role="radio" aria-checked={own} className={`option ${own ? "on" : ""}`} onClick={() => setOwn(true)}>
              <span>Use an address I already own</span>
              <small>Best if it's on another device</small>
            </button>
          </div>
          {own && <AddressInput label="Your safe address" value={safe} onChange={setSafe} />}
        </>
      ),
      ok: !own || isAddr(safe),
    },
    {
      title: "Choose a passphrase",
      lead: "It locks this wallet and your backup. Nobody can reset it, so keep it somewhere you won't lose it.",
      body: <PassphraseFields value={pass} confirm={again} onValue={setPass} onConfirm={setAgain} />,
      ok: pass.length >= 8 && pass === again,
    },
  ];
  const page = pages[step]!;
  const next = (e: FormEvent) => {
    e.preventDefault();
    if (!page.ok) return;
    if (step === 3) void make();
    else setStep(step + 1);
  };

  return (
    <form className="flow" onSubmit={next}>
      <div className="flow-top">
        {step === 0 ? (
          <a className="back" href="#/" aria-label="Back">
            <BackIcon />
          </a>
        ) : (
          <button type="button" className="back" aria-label="Back" onClick={() => setStep(step - 1)}>
            <BackIcon />
          </button>
        )}
        <div className="pips" role="img" aria-label={`Step ${step + 1} of 4`}>
          {pages.map((_, i) => (
            <i key={i} className={i <= step ? "on" : ""} />
          ))}
        </div>
      </div>
      <div className="flow-body" key={step}>
        <h1>{page.title}</h1>
        <p className="lead">{page.lead}</p>
        {page.body}
      </div>
      <button className="btn primary" disabled={!page.ok}>
        {step === 3 ? "Make my wallet" : "Continue"}
      </button>
    </form>
  );
}

const BackIcon = () => (
  <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden>
    <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Can't be skipped: the shell keeps sending people here until the file is saved and the box ticked. */
export function Backup({ onDone }: { onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const [ticked, setTicked] = useState(false);
  const grab = async () => {
    setBusy(true);
    setFailed(null);
    try {
      download("vajra-backup.txt", await engine.backup());
      setSaved(true);
    } catch (e) {
      setFailed(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flow">
      <div className="flow-body">
        <h1>Save your backup</h1>
        <p className="lead">If this device breaks or gets wiped, this file brings your wallet back. It's locked with your passphrase, so the file alone is no use to a thief.</p>
        {failed !== null && <Failed e={failed} />}
        <button className={`btn ${saved ? "" : "primary"}`} disabled={busy} onClick={() => void grab()}>
          {busy ? "Preparing the file" : saved ? "Download it again" : "Download backup file"}
        </button>
        {saved && (
          <label className="check">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
            <span>I saved the file somewhere other than this device, like a cloud drive or a USB stick.</span>
          </label>
        )}
      </div>
      <button
        className={`btn ${saved ? "primary" : ""}`}
        disabled={!ticked}
        onClick={() => {
          note.set("backupPending", null);
          onDone();
        }}
      >
        Go to my wallet
      </button>
    </section>
  );
}

export function Lock({ onOpen }: { onOpen: () => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  const open = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setBad(null);
    try {
      await engine.unlock(pass);
      onOpen();
    } catch (err) {
      setBad(plainError(err).what);
      setBusy(false);
    }
  };
  return (
    <form className="flow lock" onSubmit={(e) => void open(e)}>
      <Brand />
      <div className="flow-body">
        <h1>Welcome back</h1>
        <label className="field">
          <span>Passphrase</span>
          <input type="password" autoComplete="current-password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} aria-invalid={!!bad} />
          {bad && (
            <small className="danger-text" role="alert">
              {bad}
            </small>
          )}
        </label>
      </div>
      <div className="stack">
        <button className="btn primary" disabled={busy || !pass}>
          {busy ? "Opening" : "Open wallet"}
        </button>
        <a className="btn quiet" href="#/recover">
          Forgot it? Recover with paper
        </a>
      </div>
    </form>
  );
}

export function Restore({ onDone, onCleared }: { onDone: () => void; onCleared: () => void }) {
  const { run } = useTasks();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [pass, setPass] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [, rerender] = useState(0);
  if (engine.state() === "locked")
    return (
      <Screen title="Restore from backup" back="/">
        <ClearLocked
          what="restore"
          onCleared={() => {
            rerender((n) => n + 1);
            onCleared();
          }}
        />
      </Screen>
    );
  return (
    <Screen title="Restore from backup" back="/" lead="Pick the file you saved, and type the passphrase that locks it.">
      <input
        ref={input}
        type="file"
        hidden
        data-testid="file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBad(null);
          f.text().then(
            (text) => setFile({ name: f.name, text }),
            () => setBad("That file couldn't be read. Try picking it again."),
          );
        }}
      />
      <button className="btn" onClick={() => input.current?.click()}>
        {file ? file.name : "Choose backup file"}
      </button>
      {bad && <p className="note-danger">{bad}</p>}
      <label className="field">
        <span>Passphrase</span>
        <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <button
        className="btn primary"
        disabled={!file || !pass}
        onClick={() =>
          void run({ title: "Restoring your wallet", run: (s) => engine.restore(file!.text, pass, s) }).then((v) => {
            if (engine.state() === "open" && v !== null) onDone();
          })
        }
      >
        Restore wallet
      </button>
    </Screen>
  );
}

/** A browser holds one wallet, so restoring or recovering here means clearing a locked one first. */
function ClearLocked({ what, onCleared }: { what: string; onCleared: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <>
      <p className="note-warn">This browser still holds a locked wallet. To {what} here, it has to go first.</p>
      <label className="check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>Remove the locked wallet from this browser. Its money stays on the chain, but I'll need my backup or paper to reach it.</span>
      </label>
      <button
        className="btn danger"
        disabled={!sure}
        onClick={() => {
          engine.forget();
          note.set("backupPending", null);
          onCleared();
        }}
      >
        Remove locked wallet
      </button>
    </>
  );
}

/**
 * `recover` keeps running through the whole public wait, then finishes by itself. So this screen stays up for all of it, and reads the
 * countdown from the chain while it runs.
 */
export function Recover({ onDone, onCleared }: { onDone: () => void; onCleared: () => void }) {
  const [paper, setPaper] = useState("");
  const [account, setAccount] = useState("");
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [phase, setPhase] = useState<"form" | "running" | "done">("form");
  const [lines, setLines] = useState<string[]>([]);
  const [failed, setFailed] = useState<ReturnType<typeof plainError> | null>(null);
  const [result, setResult] = useState<Done | null>(null);
  const [wait, setWait] = useState<{ until: number; offset: number } | null>(null);
  const [, rerender] = useState(0);
  useTick();

  useEffect(() => {
    if (phase !== "running" || failed) return;
    const look = () => {
      if (engine.state() !== "open") return;
      engine.snapshot().then(
        (s) => {
          const item = s.queue?.find((q) => q.isRecovery);
          if (item && s.chainTime !== null) setWait({ until: item.executeAfter, offset: s.chainTime - Date.now() / 1000 });
        },
        () => {},
      );
    };
    const timer = setInterval(look, 4000);
    look();
    return () => clearInterval(timer);
  }, [phase, failed, lines.length]);

  const start = async () => {
    setPhase("running");
    setLines([]);
    setFailed(null);
    setWait(null);
    try {
      setResult(await engine.recover(paper.trim(), account as Address, pass, (line) => setLines((l) => [...l, line])));
      setPhase("done");
    } catch (e) {
      setFailed(plainError(e));
    }
  };

  if (phase === "done")
    return (
      <section className="flow">
        <div className="flow-body">
          <div className="row-tight">
            <Tick />
            <h1>Your account is back</h1>
          </div>
          <p className="lead">This device now holds new keys. Nobody cancelled the recovery, so the old ones stopped working.</p>
          {result && <Proof done={result} />}
        </div>
        <button className="btn primary" onClick={onDone}>
          Go to my wallet
        </button>
      </section>
    );

  if (phase === "running") {
    const left = wait ? wait.until - (Date.now() / 1000 + wait.offset) : null;
    return (
      <section className="flow">
        <div className="flow-body">
          <h1>{failed ? failed.title : wait ? "Recovery is waiting" : "Recovering your account"}</h1>
          {failed ? (
            <p className="lead" role="alert">
              {failed.what}
            </p>
          ) : wait ? (
            <>
              <p className="count" role="timer">
                {clock(left ?? 0)}
              </p>
              <p className="lead">It waits in public, so the real owner can cancel it with their hash key. If that's you, just keep this screen open. It finishes by itself.</p>
            </>
          ) : (
            <p className="lead">Keep this screen open. Proving you hold the paper can take a minute.</p>
          )}
          <Steps lines={lines} failed={!!failed} />
        </div>
        {failed && (
          <div className="stack">
            <button className="btn primary" onClick={() => void start()}>
              Try again
            </button>
            <button
              className="btn"
              onClick={() => {
                setFailed(null);
                setPhase("form");
              }}
            >
              Change my answers
            </button>
          </div>
        )}
      </section>
    );
  }

  const ok = paper.trim().length > 0 && isAddr(account) && pass.length >= 8 && pass === again;
  const locked = engine.state() === "locked";
  return (
    <Screen title="Recover with paper" back="/" lead="Lost everything? Your paper can take your account back. It starts a public wait, so a thief holding your paper can be stopped by you.">
      {locked ? (
        <ClearLocked
          what="recover"
          onCleared={() => {
            rerender((n) => n + 1);
            onCleared();
          }}
        />
      ) : (
        <>
          <label className="field">
            <span>Your recovery paper</span>
            <textarea rows={3} autoCapitalize="off" autoComplete="off" spellCheck={false} className="mono-input" value={paper} onChange={(e) => setPaper(e.target.value)} placeholder="Type it exactly as written" />
          </label>
          <AddressInput label="Your account address" value={account} onChange={setAccount} />
          <PassphraseFields label="New passphrase" value={pass} confirm={again} onValue={setPass} onConfirm={setAgain} />
          <button className="btn primary" disabled={!ok} onClick={() => void start()}>
            Start recovery
          </button>
        </>
      )}
    </Screen>
  );
}

/** After `recover`: the public wait, then finishing it. */
export function Recovering() {
  const { snap, chainNow, error, refresh } = useLive();
  const { run } = useTasks();
  useTick();
  if (!snap) return error ? <Failed e={error} retry={() => void refresh()} /> : <Loading what="Reading your account from the chain" />;
  const item = snap.queue?.find((q) => q.isRecovery);
  if (snap.queue === null)
    return (
      <Screen title="Recovery is waiting" lead="The chain can't be read right now, so the time left is unknown.">
        <Failed e={error ?? new Error("network")} retry={() => void refresh()} />
      </Screen>
    );
  if (!item && snap.recoveryPending)
    return (
      <Screen title="Almost there" lead="Your new hash key is in. One last step gives this wallet a new wallet key and safe.">
        <button
          className="btn primary"
          onClick={() =>
            void run({
              title: "Finishing recovery",
              run: (s) => engine.finishRecovery(s),
              result: (d) => ({ title: "Your new key took over", body: "This device now holds your account.", done: d, action: "Go to Home" }),
            }).then((v) => {
              if (v) go("/");
            })
          }
        >
          Finish recovery
        </button>
      </Screen>
    );
  if (!item)
    return (
      <Screen title="Nothing is waiting" lead="No recovery is waiting on this account. If you just started one, it was either finished or cancelled by whoever holds the hash key.">
        <a className="btn primary" href="#/">
          Go to Home
        </a>
      </Screen>
    );
  const now = chainNow();
  const left = now === null ? null : item.executeAfter - now;
  const due = left !== null && left <= 0;
  return (
    <Screen title={due ? "The wait is over" : "Recovery is waiting"} lead={due ? "Nobody cancelled it. Finish now and your new key takes over." : "It waits in public so the real owner can cancel it. If that's you, there's nothing to do but wait."}>
      <p className="count" aria-live="off">
        {left === null ? "Unknown time left" : due ? "0:00" : clock(left)}
      </p>
      <button
        className="btn primary"
        disabled={!due}
        onClick={() =>
          void run({
            title: "Finishing recovery",
            run: (s) => engine.finishRecovery(s),
            result: (d) => ({ title: "Your new key took over", body: "This device now holds your account.", done: d, action: "Go to Home" }),
          }).then((v) => {
            if (v) go("/");
          })
        }
      >
        {due ? "Finish recovery" : "Waiting"}
      </button>
    </Screen>
  );
}

/** The phone's side of moving the hash key. */
export function ReceiveKey({ link, onReceived }: { link: string; onReceived: () => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const receive = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setBad(null);
    try {
      await engine.receiveHashKey(link, pass);
      setDone(true);
      onReceived();
    } catch (err) {
      setBad(plainError(err).what);
    } finally {
      setBusy(false);
    }
  };
  if (!done && engine.state() !== "empty")
    return (
      <section className="flow">
        <Brand />
        <div className="flow-body">
          <h1>Open this on your phone</h1>
          <p className="lead">This browser already has a wallet in it. A hash key can only move to a device with no wallet on it, so scan the code with your phone instead.</p>
        </div>
        <a className="btn primary" href="#/">
          Back to my wallet
        </a>
      </section>
    );
  if (done)
    return (
      <section className="flow">
        <div className="flow-body">
          <div className="row-tight">
            <Tick />
            <h1>Your hash key is here</h1>
          </div>
          <p className="lead">This phone can now cancel payments, freeze and escape. Go back to the other device and tap "It's on my phone" to finish the move.</p>
        </div>
        <a className="btn primary" href="#/">
          Open wallet
        </a>
      </section>
    );
  return (
    <form className="flow" onSubmit={(e) => void receive(e)}>
      <Brand />
      <div className="flow-body">
        <h1>Bring your hash key to this phone</h1>
        <p className="lead arc-lead">This link works once. Type the passphrase of the wallet you're moving it from.</p>
        <label className="field">
          <span>Passphrase</span>
          <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} aria-invalid={!!bad} />
          {bad && (
            <small className="danger-text" role="alert">
              {bad}
            </small>
          )}
        </label>
      </div>
      <button className="btn arc" disabled={busy || !pass}>
        {busy ? <Spin /> : "Receive hash key"}
      </button>
    </form>
  );
}

