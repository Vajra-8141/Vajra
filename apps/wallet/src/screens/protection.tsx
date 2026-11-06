/** The backbone: one checklist in story order. Each row names a danger, then the fix, and each fix raises the next danger. */
import { useState, type ReactNode } from "react";
import type { Done, Snapshot } from "../engine-types";
import { engine } from "../wallet";
import { Bars, CancelMoment, DelayPicker, download, duration, eth, Failed, go, plainError, Proof, Qr, Copy, Screen, short, Tick, useLive, useTasks, WithSnap } from "../ui";
import { QueueCard, useNotMe } from "./home";

interface Row {
  id: string;
  title: string;
  danger: string;
  fix: string;
  done: boolean;
}

export function rows(s: Snapshot): Row[] {
  const did = (k: string) => s.history.some((h) => h.kind === k);
  return [
    { id: "backup", title: "Backed up", danger: "If this device dies, your wallet could die with it.", fix: "An encrypted file you keep somewhere else brings it back.", done: s.backedUp },
    { id: "alerts", title: "Get warned", danger: "A thief won't tell you they've started.", fix: "An alert reaches you the moment a payment starts waiting.", done: s.alerts.telegram || s.alerts.push },
    { id: "drill", title: "Practice a theft", danger: "The worst time to learn this is during a real theft.", fix: "Rob yourself once, and stop it, so you know what it looks like.", done: did("cancelled") },
    { id: "freeze", title: "Freeze and unfreeze", danger: "Sometimes something feels wrong, but you can't see what.", fix: "A freeze stops your wallet key completely until you lift it.", done: did("frozen") && did("unfreeze") && s.frozen === false },
    { id: "exit", title: "Second way out", danger: "Your hash key could be lost just when you need to run.", fix: "A separate address with its own money can still move everything to your safe.", done: s.exit !== null },
    { id: "paper", title: "Recovery paper", danger: "You could lose this device and your backup together.", fix: "A few words on paper take your account back on any new device.", done: s.recoverySet === true },
    { id: "move", title: "Move the hash key to your phone", danger: "With both keys here, one stolen device holds both.", fix: "Keep the hash key on your phone, and a thief needs two devices.", done: !s.hashKeyHere },
  ];
}
export const nextStep = (s: Snapshot) => rows(s).find((r) => !r.done) ?? null;

export function Protection() {
  return (
    <WithSnap>
      {(s) => <Checklist s={s} />}
    </WithSnap>
  );
}

function Checklist({ s }: { s: Snapshot }) {
  const all = rows(s);
  const count = all.filter((r) => r.done).length;
  const first = all.find((r) => !r.done)?.id ?? null;
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const open = picked === undefined ? first : picked;
  return (
    <section className="screen">
      <header className="screen-head">
        <h1>Protection</h1>
      </header>
      <div className="progress">
        <p>{count === all.length ? "Every step is done." : `${count} of ${all.length} done`}</p>
        <div className="meter" role="img" aria-label={`${count} of ${all.length} steps done`}>
          <i style={{ width: `${(count / all.length) * 100}%` }} />
        </div>
      </div>
      <ol className="thread">
        {all.map((r, i) => {
          const isOpen = open === r.id;
          return (
            <li key={r.id} className={`step ${r.done ? "is-done" : ""} ${isOpen ? "is-open" : ""}`} data-step={r.id}>
              <button className="step-head" aria-expanded={isOpen} onClick={() => setPicked(isOpen ? null : r.id)}>
                <span className="node">{r.done ? <Tick small /> : i + 1}</span>
                <span className="step-text">
                  <strong>{r.title}</strong>
                  {!isOpen && <small>{r.done ? "Done" : r.danger}</small>}
                </span>
              </button>
              {isOpen && (
                <div className="step-body">
                  <p>{r.danger}</p>
                  <p className="t60">{r.fix}</p>
                  <RowAction id={r.id} s={s} done={r.done} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="emergency">
        <div>
          <h2>Escape</h2>
          <p className="t60 small">If you can see it's happening right now, move everything to your safe. This is the last resort, and it can't be undone.</p>
        </div>
        <a className="btn" href="#/escape" data-testid="escape-link">
          {s.escaped ? "See what happened" : "Open Escape"}
        </a>
      </div>
    </section>
  );
}

function RowAction({ id, s, done }: { id: string; s: Snapshot; done: boolean }) {
  const { hash } = useTasks();
  if (id === "backup") return <BackupAgain done={done} />;
  if (id === "alerts") return <Alerts s={s} />;
  if (id === "drill")
    return (
      <a className="btn primary" href="#/drill">
        {done ? "Practice again" : "Start the practice"}
      </a>
    );
  if (id === "freeze") {
    const freeze = () => void hash({ what: "Freeze your wallet", detail: "Your wallet key can't send anything until you unfreeze. Your hash key still works.", confirm: "Freeze" }, { title: "Freezing", run: (x) => engine.freeze(x), result: (d) => ({ title: "Frozen", body: "Your wallet key is stopped. Now lift it, so you've seen both halves.", done: d, signed: true }) });
    const unfreeze = () => void hash({ what: "Unfreeze your wallet", detail: "Your wallet key can spend again.", confirm: "Unfreeze" }, { title: "Unfreezing", run: (x) => engine.unfreeze(x), result: (d) => ({ title: "Unfrozen", body: "Your wallet key works again.", done: d, signed: true }) });
    return s.frozen ? (
      <button className="btn arc" onClick={unfreeze}>
        Unfreeze
      </button>
    ) : (
      <button className="btn arc" onClick={freeze}>
        Freeze now
      </button>
    );
  }
  if (id === "exit")
    return s.exit ? (
      <dl className="facts">
        <dt>Its address</dt>
        <dd className="mono">{short(s.exit.address)}</dd>
        <dt>Its own money</dt>
        <dd>{s.exit.reserve === null ? "unknown" : `${eth(s.exit.reserve)} ETH`}</dd>
      </dl>
    ) : (
      <button
        className="btn arc"
        onClick={() =>
          void hash(
            { what: "Set up a second way out", detail: "A new address gets a little of your ETH, kept apart for one job: moving everything to your safe.", confirm: "Set it up" },
            { title: "Setting up your second way out", run: (x) => engine.setupExit(x), result: (d) => ({ title: "Second way out is ready", body: "Lose the hash key, and your money can still reach your safe.", done: d, signed: true }) },
          )
        }
      >
        Set up second way out
      </button>
    );
  if (id === "paper")
    return (
      <a className={`btn ${done ? "" : "primary"}`} href="#/paper">
        {done ? "Make a new paper" : "Make my paper"}
      </a>
    );
  if (id === "move")
    return done ? (
      <p className="t60 small">Your hash key is on your phone. Hash key actions happen there now.</p>
    ) : (
      <a className="btn primary" href="#/move">
        Move it to my phone
      </a>
    );
  return null;
}

function BackupAgain({ done }: { done: boolean }) {
  const [state, set] = useState<"idle" | "busy" | "ok">("idle");
  const [bad, setBad] = useState<unknown>(null);
  return (
    <>
      {bad !== null && <Failed e={bad} />}
      <button
        className={`btn ${done ? "" : "primary"}`}
        disabled={state === "busy"}
        onClick={() => {
          set("busy");
          setBad(null);
          engine.backup().then(
            (text) => {
              download("vajra-backup.txt", text);
              set("ok");
            },
            (e) => {
              setBad(e);
              set("idle");
            },
          );
        }}
      >
        {state === "busy" ? "Preparing the file" : state === "ok" ? "Downloaded. Download again" : "Download backup"}
      </button>
    </>
  );
}

function Alerts({ s }: { s: Snapshot }) {
  const { refresh } = useLive();
  const [busy, setBusy] = useState<"telegram" | "push" | null>(null);
  const [bad, setBad] = useState<ReturnType<typeof plainError> | null>(null);
  const ua = navigator.userAgent;
  const iphone = /iPhone|iPad|iPod/.test(ua);
  const installed = matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const telegram = async () => {
    setBusy("telegram");
    setBad(null);
    // Opened first, so the browser treats it as the tap's own window.
    const tab = window.open("", "_blank");
    try {
      const url = await engine.telegramLink();
      if (tab) tab.location.href = url;
      else location.href = url;
    } catch (e) {
      tab?.close();
      setBad(plainError(e));
    } finally {
      setBusy(null);
    }
  };
  const push = async () => {
    setBusy("push");
    setBad(null);
    try {
      await engine.enablePush();
      await refresh();
    } catch (e) {
      setBad(plainError(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {bad && (
        <p className="note-danger" role="alert">
          {bad.what}
        </p>
      )}
      {iphone && !installed && !s.alerts.push && <p className="note-warn">On iPhone, push only works after you add VAJRA to your Home Screen. Telegram works anywhere.</p>}
      <div className="two">
        <button className="btn" disabled={busy !== null || s.alerts.telegram} onClick={() => void telegram()}>
          {s.alerts.telegram ? "Telegram is on" : busy === "telegram" ? "Opening Telegram" : "Use Telegram"}
        </button>
        <button className="btn" disabled={busy !== null || s.alerts.push} onClick={() => void push()}>
          {s.alerts.push ? "Push is on" : busy === "push" ? "Turning on" : "Use push"}
        </button>
      </div>
      {busy === null && !s.alerts.telegram && <p className="t40 small">After you tap Start in Telegram, this page updates by itself.</p>}
    </>
  );
}

/** The star of the product. */
export function Drill() {
  const { run } = useTasks();
  const notMe = useNotMe();
  const [id, setId] = useState<string | null>(null);
  const [dead, setDead] = useState<{ item: NonNullable<Snapshot["queue"]>[number]; done: Done } | null>(null);
  return (
    <Screen title="Practice a theft" back="/protection">
      <WithSnap>
        {(s) => {
          if (dead)
            return (
              <div className="drill-end">
                <h2 className="big-line">Your hash key killed that payment.</h2>
                <p className="t60">A thief with your wallet key just hit the wall you've built. They could only try. You outrank them, and it happened in public, on the chain.</p>
                <CancelMoment item={dead.item} hash={dead.done.hash} />
                <Proof done={dead.done} />
                <a className="btn primary" href="#/protection">
                  Next: freeze and unfreeze
                </a>
              </div>
            );
          const item = id ? s.queue?.find((q) => q.id === id) : undefined;
          if (id && item)
            return (
              <div className="drill-live">
                <p className="lead">This is what a theft looks like. Your wallet key signed it, and it's waiting in public.</p>
                <QueueCard
                  item={item}
                  snap={s}
                  onNotMe={() =>
                    void notMe(
                      item,
                      (d) => {
                        setDead({ item, done: d });
                      },
                      true,
                    )
                  }
                />
                {s.alerts.telegram || s.alerts.push ? (
                  <p className="t60">Check your {s.alerts.telegram ? "Telegram" : "phone"}. Your alert should arrive now, the same one you'd get in a real theft.</p>
                ) : (
                  <p className="note-warn">
                    You have no alerts on, so a real theft would stay quiet until you opened this app. <a href="#/protection">Set them up</a> after this.
                  </p>
                )}
                <p className="t60">It's not you, so tap Not me.</p>
              </div>
            );
          if (id)
            return (
              <div className="state">
                <h2>That payment is no longer waiting</h2>
                <p className="t60">It was finished or cancelled elsewhere. Activity shows which.</p>
                <button className="btn" onClick={() => go("/activity")}>
                  See activity
                </button>
              </div>
            );
          const blocked = s.frozen ? "Your wallet is frozen, so a thief couldn't even try. Unfreeze first." : s.escaped ? "This wallet has escaped, so there's nothing left to steal." : !s.walletKeyHere ? "Your wallet key is on your other device. Start the practice there, and answer it here." : null;
          return (
            <>
              <p className="lead">Let's rob you, for real. Your own wallet key, the one a thief would steal, will try to send more than your limit to a random address.</p>
              <ul className="plain">
                <li>This is a real attempt on the public chain, not a simulation.</li>
                <li>The money doesn't leave. It waits in public for {s.delaySeconds === null ? "your delay" : duration(s.delaySeconds)}.</li>
                <li>You stop it with your hash key, which uses 1 of its uses.</li>
                <li>If you walk away and the wait ends, anyone can finish it and the money is gone. It's test money, but stay for the end.</li>
              </ul>
              {blocked && <p className="note-warn">{blocked}</p>}
              <button
                className="btn primary"
                disabled={!!blocked}
                onClick={() =>
                  void run({ title: "Trying to rob you", run: (x) => engine.drill(x) }).then((r) => {
                    if (r) setId(r.route === "queued" ? r.id : null);
                  })
                }
              >
                Start the theft
              </button>
            </>
          );
        }}
      </WithSnap>
    </Screen>
  );
}

/** Shows the paper once, then asks them to prove they wrote it down. */
export function Paper() {
  const { hash } = useTasks();
  const [delay, setDelay] = useState(120);
  const [made, setMade] = useState<({ paper: string } & Done) | null>(null);
  const [check, setCheck] = useState("");
  const [finished, setFinished] = useState(false);
  if (finished)
    return (
      <Screen title="Your paper is set" lead="Keep it away from this device. If a thief finds it, the wait below gives you time to cancel, as long as your hash key is safe.">
        <p className="t60">Now one stolen device shouldn't hold both keys. Moving the hash key is next.</p>
        <a className="btn primary" href="#/protection">
          Back to Protection
        </a>
      </Screen>
    );
  if (made) {
    const tail = made.paper.trim().slice(-4).toLowerCase();
    const ok = check.trim().toLowerCase() === tail;
    return (
      <Screen title="Write this down" lead="On paper, by hand. It won't be shown again, and it's never stored here.">
        <p className="paper" data-testid="paper">
          {made.paper}
        </p>
        <Bars hash={made.hash} still />
        <Proof done={made} />
        <label className="field">
          <span>To check, type the last 4 characters</span>
          <input autoCapitalize="off" autoComplete="off" spellCheck={false} maxLength={8} value={check} onChange={(e) => setCheck(e.target.value)} />
        </label>
        <button className="btn primary" disabled={!ok} onClick={() => setFinished(true)}>
          I've written it down
        </button>
      </Screen>
    );
  }
  return (
    <Screen title="Recovery paper" back="/protection" lead="A few words that take your account back on a new device, with nothing else. Using it starts a public wait, so you can cancel a thief who found it.">
      <div className="field">
        <span>How long should a recovery wait?</span>
        <DelayPicker value={delay} onChange={setDelay} />
      </div>
      <button
        className="btn arc"
        onClick={() =>
          void hash(
            { what: "Set up your recovery paper", detail: `Anyone using it must wait ${duration(delay)} in public first. The paper shows next, once.`, confirm: "Make my paper" },
            { title: "Making your paper", run: (x) => engine.setupRecovery(delay, x) },
          ).then((r) => {
            if (r) setMade(r);
          })
        }
      >
        Make my paper
      </button>
    </Screen>
  );
}

export function Move() {
  const { run } = useTasks();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<unknown>(null);
  const [sure, setSure] = useState(false);
  const show = async () => {
    setBusy(true);
    setBad(null);
    try {
      setLink(await engine.moveHashKeyLink());
    } catch (e) {
      setBad(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="Move the hash key" back="/protection" lead="Your wallet key stays here for everyday spending. Your hash key goes to your phone, so no single device holds both.">
      <WithSnap>
        {(s) =>
          !s.hashKeyHere ? (
            <div className="state">
              <h2>Your hash key is on your phone</h2>
              <p className="t60">It no longer works from this device.</p>
              <a className="btn" href="#/protection">
                Back to Protection
              </a>
            </div>
          ) : link ? (
            <>
              <ol className="plain numbered">
                <li>Scan this with your phone's camera. It's locked with your passphrase, and it works once.</li>
                <li>On your phone, type your passphrase and tap Receive hash key.</li>
                <li>Come back here and confirm.</li>
              </ol>
              <Qr text={link} label="QR code that moves your hash key" />
              <Copy text={link} label="Copy link instead" />
              <label className="check">
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                <span>My phone says the hash key is there. This device will stop being able to use it.</span>
              </label>
              <button
                className="btn arc"
                disabled={!sure}
                onClick={() =>
                  void run({ title: "Finishing the move", run: async (x) => (x("Removing the hash key from this device"), await engine.confirmMoved(), true) }).then((v) => {
                    if (v) go("/protection");
                  })
                }
              >
                It's on my phone
              </button>
            </>
          ) : (
            <>
              {bad !== null && <Failed e={bad} />}
              <button className="btn primary" disabled={busy} onClick={() => void show()}>
                {busy ? "Making the link" : "Show the QR code"}
              </button>
            </>
          )
        }
      </WithSnap>
    </Screen>
  );
}

export function Escape() {
  const { hash } = useTasks();
  return (
    <Screen title="Escape" back="/protection">
      <WithSnap>
        {(s) => {
          if (s.escaped)
            return (
              <div className="state">
                <h2>You've escaped</h2>
                <p className="t60">Everything left this account for your safe.</p>
                <a className="btn primary" href="#/safe">
                  Open your safe
                </a>
              </div>
            );
          const go2safe = (d: unknown) => {
            if (d) go("/safe");
          };
          const body: ReactNode = (
            <>
              Everything goes to <span className="mono">{short(s.safe.address)}</span>. This wallet is finished after this.
            </>
          );
          return (
            <>
              <p className="lead danger-lead">Only for an emergency. This can't be undone.</p>
              <ul className="plain">
                <li>All {s.balance === null ? "of your" : `${eth(s.balance)}`} ETH moves to your safe at once.</li>
                <li>Anything waiting in public dies with it.</li>
                <li>Your wallet key becomes worthless, to you and to a thief.</li>
              </ul>
              <dl className="facts">
                <dt>Your safe</dt>
                <dd className="mono">{short(s.safe.address)}</dd>
              </dl>
              <button
                className="btn arc"
                onClick={() =>
                  void hash(
                    { what: "Move everything to your safe", detail: body, confirm: "Escape now", typed: "ESCAPE" },
                    { title: "Escaping", run: (x) => engine.escape(x), result: (d) => ({ title: "You've escaped", body: "Your money is in your safe.", done: d, signed: true, action: "Open your safe" }) },
                  ).then(go2safe)
                }
              >
                Escape now
              </button>
              {s.exit && (
                <button
                  className="btn"
                  onClick={() =>
                    void hash(
                      { what: "Escape by your second way out", detail: body, confirm: "Escape now", typed: "ESCAPE", noUse: true },
                      { title: "Escaping", run: (x) => engine.exitEscape(x), result: (d) => ({ title: "You've escaped", body: "Your money is in your safe.", done: d, action: "Open your safe" }) },
                    ).then(go2safe)
                  }
                >
                  Hash key lost? Use the second way out
                </button>
              )}
            </>
          );
        }}
      </WithSnap>
    </Screen>
  );
}

