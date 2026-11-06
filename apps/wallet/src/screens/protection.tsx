/** What is safe, what to do about it, and what to press if something is wrong. The wallet's real state decides what comes first. */
import { useState, type ReactNode } from "react";
import type { Done, Snapshot } from "../engine-types";
import { engine } from "../wallet";
import { Bars, CancelMoment, DelayPicker, download, duration, eth, Failed, go, plainError, Proof, Qr, Copy, Screen, short, Tick, useLive, useTasks, WithSnap } from "../ui";
import { QueueCard, useNotMe } from "./home";

interface Row {
  id: string;
  title: string;
  danger: string;
  status: string;
  how: string[];
  done: boolean;
}

export function rows(s: Snapshot): Row[] {
  return [
    {
      id: "alerts",
      title: "Alerts",
      status: s.alerts.telegram && s.alerts.push ? "Telegram and push are on" : s.alerts.telegram ? "Telegram is on" : s.alerts.push ? "Push is on" : "Off",
      danger: "A thief won't tell you they've started.",
      how: ["Link Telegram, or turn on push alerts.", "If a big payment starts, you get a message within seconds.", "You then have until the countdown ends to stop it."],
      done: s.alerts.telegram || s.alerts.push,
    },
    {
      id: "backup",
      title: "Backup",
      status: !s.backedUp ? "Not saved" : s.backupStale ? "Out of date" : "Saved",
      danger: "If this device breaks, your wallet could go with it.",
      how: ["You save one locked file.", "Only your passphrase can open it.", "On a new device, tap Restore and pick that file."],
      done: s.backedUp && !s.backupStale,
    },
    {
      id: "paper",
      title: "Recovery paper",
      status: s.recoverySet === null ? "Unknown" : s.recoverySet ? "Set" : "Not set",
      danger: "You could lose your device and your backup together.",
      how: ["The app shows a secret code once. Write it on paper.", "On a new device, type the code and your wallet address.", "It waits in public first, so you can cancel it if someone stole your paper."],
      done: s.recoverySet === true,
    },
    {
      id: "exit",
      title: "Second way out",
      status: s.exit ? (s.exit.reserve === null ? "Ready" : `Ready, with ${eth(s.exit.reserve)} ETH`) : "Not set up",
      danger: "You might need to run when your wallet is blocked, or your hash key is gone.",
      how: ["The app makes a small helper account with its own key and its own money.", "The helper can only do one thing: move everything to your safe.", "If your wallet is blocked or you lose your phone, use it from the Escape screen."],
      done: s.exit !== null,
    },
    {
      id: "move",
      title: "Hash key",
      status: !s.hashKeyHere ? "On your phone" : s.hashKeyLeft === null ? "On this device" : `On this device, ${s.hashKeyLeft} uses left`,
      danger: "If both keys are on one device, one theft gets both.",
      how: ["Scan a QR code with your phone, and type your passphrase there.", "This device keeps spending. Your phone becomes the guard.", "If a theft starts, your phone is where you tap Not me."],
      done: !s.hashKeyHere || !s.walletKeyHere,
    },
  ];
}

export interface Suggestion {
  id: string;
  title: string;
  danger: string;
  /** Where it goes. Without one, it opens that row. */
  href?: string;
}

/** One thing worth doing next, read from the wallet as it is now. */
export function nextStep(s: Snapshot): Suggestion | null {
  if (s.escaped) return null;
  const practised = s.history.some((h) => h.kind === "cancelled");
  if (!s.alerts.telegram && !s.alerts.push) return { id: "alerts", title: "Turn on alerts", danger: "Right now a theft would stay quiet until you opened this app." };
  if (s.backupStale) return { id: "backup", title: "Save a new backup", danger: "Your last backup is missing something you added since." };
  if (s.hashKeyLeft !== null && s.hashKeyLeft <= 8) return { id: "rotate", title: "Replace your hash key soon", danger: `It has ${s.hashKeyLeft} uses left.`, href: "#/settings" };
  if (!practised && s.walletKeyHere) return { id: "drill", title: "Practice a theft", danger: "Your first time shouldn't be a real theft.", href: "#/drill" };
  if (s.recoverySet === false) return { id: "paper", title: "Make a recovery paper", danger: "If you lose this device and your backup, the paper still gets your wallet back." };
  if (!s.exit && s.hashKeyHere) return { id: "exit", title: "Set up a second way out", danger: "It still gets your money out if your wallet is blocked." };
  if (s.hashKeyHere && s.walletKeyHere) return { id: "move", title: "Move your hash key to your phone", danger: "Both keys are on this device, so one theft could get both." };
  return null;
}

export function Protection() {
  return (
    <WithSnap>
      {(s) => <Safety s={s} />}
    </WithSnap>
  );
}

function FreezeButton({ s }: { s: Snapshot }) {
  const { hash } = useTasks();
  const freeze = () => void hash({ what: "Freeze your wallet", detail: "Your wallet key can't send anything until you unfreeze. Your hash key still works.", confirm: "Freeze" }, { title: "Freezing", run: (x) => engine.freeze(x), result: (d) => ({ title: "Frozen", body: "Your wallet key is stopped. Nothing can be sent until you unfreeze.", done: d, signed: true }) });
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

function Safety({ s }: { s: Snapshot }) {
  const all = rows(s);
  const [open, setOpen] = useState<string | null>(null);
  const tip = nextStep(s);
  const practised = s.history.some((h) => h.kind === "cancelled");
  const waiting = s.queue ?? [];
  return (
    <section className="screen">
      <header className="screen-head">
        <h1>Protection</h1>
      </header>
      <p className="lead">The wallet key spends small amounts. The hash key can stop anything.</p>

      {waiting.map((item) => (
        <QueueCard key={item.id} item={item} snap={s} />
      ))}

      <div className="sos">
        <h2>Something wrong?</h2>
        {s.escaped ? (
          <a className="btn" href="#/safe">
            Open your safe
          </a>
        ) : (
          <>
            <p className="t60 small">Freeze stops all spending until you lift it. Escape moves everything to your safe, and you can't undo it.</p>
            <div className="sos-actions">
              <FreezeButton s={s} />
              <a className="btn" href="#/escape" data-testid="escape-link">
                Escape
              </a>
            </div>
          </>
        )}
      </div>

      {tip && (
        <a
          className="nextup"
          href={tip.href ?? "#/protection"}
          onClick={(e) => {
            if (tip.href) return;
            e.preventDefault();
            setOpen(tip.id);
          }}
        >
          <div>
            <small>Suggested for you</small>
            <strong>{tip.title}</strong>
            <p className="t60 small">{tip.danger}</p>
          </div>
          <Chevron />
        </a>
      )}

      <div className="group-head">
        <h2>Your safety</h2>
      </div>
      <ul className="safety">
        {all.map((r) => {
          const isOpen = open === r.id;
          return (
            <li key={r.id} className={`step ${r.done ? "is-done" : ""} ${isOpen ? "is-open" : ""}`} data-step={r.id}>
              <button className="step-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                <span className="step-text">
                  <strong>{r.title}</strong>
                  <small className={r.done ? "safe-on" : ""}>{r.status}</small>
                </span>
                <Chevron />
              </button>
              {isOpen && (
                <div className="step-body">
                  <p>{r.danger}</p>
                  <ol className="how">
                    {r.how.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                  <RowAction id={r.id} s={s} done={r.done} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!s.escaped && s.walletKeyHere && (
        <div className="practice">
          <div>
            <h2>Practice a theft</h2>
            <p className="t60 small">Rob yourself with a real attempt on the chain, then stop it. It takes about a minute.</p>
          </div>
          <a className="btn primary" href="#/drill">
            {practised ? "Practice again" : "Start the practice"}
          </a>
        </div>
      )}
    </section>
  );
}

const Chevron = () => (
  <svg className="chev" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m8 5 5 5-5 5" />
  </svg>
);

function RowAction({ id, s, done }: { id: string; s: Snapshot; done: boolean }) {
  const { hash } = useTasks();
  if (id === "backup") return <BackupAgain done={done} />;
  if (id === "alerts") return <Alerts s={s} />;
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
            { what: "Set up a second way out", detail: "A small helper account is made, with its own money, for one job: moving everything to your safe.", confirm: "Set it up" },
            { title: "Setting up your second way out", run: (x) => engine.setupExit(x), result: (d) => ({ title: "Second way out is ready", body: "If your wallet is blocked or your hash key is lost, this can still move everything to your safe. Download a new backup in step 1, so the helper's key is saved too.", done: d, signed: true }) },
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
                  Wallet blocked or hash key lost? Use the second way out
                </button>
              )}
            </>
          );
        }}
      </WithSnap>
    </Screen>
  );
}

