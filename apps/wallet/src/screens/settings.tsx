import { useState } from "react";
import { engine } from "../wallet";
import { Copy, download, duration, eth, Failed, go, Limit, note, Screen, short, useTasks, WithSnap } from "../ui";
import { Chevron } from "./home";

export function Settings({ onLock }: { onLock: () => void }) {
  const { hash } = useTasks();
  const [limit, setLimit] = useState<string | null>(null);
  const [bad, setBad] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const grab = () => {
    setBad(null);
    engine.backup().then(
      (t) => {
        download("vajra-backup.txt", t);
        setSaved(true);
      },
      setBad,
    );
  };
  return (
    <Screen title="Settings">
      <WithSnap>
        {(s) => {
          const value = limit ?? (s.dailyLimit === null ? "0.02" : String(Number(s.dailyLimit)));
          const changed = s.dailyLimit !== null && Number(value) !== Number(s.dailyLimit);
          const left = s.hashKeyLeft;
          return (
            <>
              <section className="set">
                <h2>Daily limit</h2>
                <p className="t60 small">Only your hash key can change this, so a thief can't raise it. {s.delaySeconds === null ? "" : `Bigger payments wait ${duration(s.delaySeconds)}.`}</p>
                {s.dailyLimit === null && <p className="note-warn">Your current limit can't be read right now.</p>}
                <Limit value={value} onChange={setLimit} />
                {changed && (
                  <button
                    className="btn arc"
                    onClick={() =>
                      void hash(
                        { what: `Change your daily limit to ${value} ETH`, detail: `It's ${eth(s.dailyLimit)} ETH now.`, confirm: "Change limit" },
                        { title: "Changing your limit", run: (x) => engine.setLimit(value, x), result: (d) => ({ title: "Limit changed", body: `Your wallet key can now spend ${value} ETH a day.`, done: d, signed: true }) },
                      ).then((d) => {
                        if (d) setLimit(null);
                      })
                    }
                  >
                    Change limit
                  </button>
                )}
              </section>

              <section className="set">
                <h2>Hash key</h2>
                <div className="facts-line">
                  <span>{s.hashKeyHere ? "On this device" : "On your phone"}</span>
                  <span className="arc-text">{left === null ? "Uses left: unknown" : `${left} of ${s.hashKeyTotal} uses left`}</span>
                </div>
                {left !== null && (
                  <div className="meter meter-arc" role="img" aria-label={`${left} of ${s.hashKeyTotal} uses left`}>
                    <i style={{ width: `${(left / s.hashKeyTotal) * 100}%` }} />
                  </div>
                )}
                {left !== null && left <= 8 && <p className="note-warn">It's running out. Replace it while you still can.</p>}
                <p className="t60 small">Each use signs once and is gone. Replacing it gives you a fresh one on this account, with the same address.</p>
                <button
                  className="btn"
                  onClick={() =>
                    void hash(
                      { what: "Replace your hash key", detail: "A new one takes over, with all its uses. The old one stops working.", confirm: "Replace hash key" },
                      { title: "Replacing your hash key", run: (x) => engine.rotate(x), result: (d) => ({ title: "Hash key replaced", body: "Your new hash key is in charge. Download a fresh backup, because the old file holds the old key.", done: d, signed: true }) },
                    )
                  }
                >
                  Replace hash key
                </button>
              </section>

              <section className="set">
                <h2>More</h2>
                <a className="link-row" href="#/pool">
                  <span>Private pool</span>
                  <Chevron />
                </a>
                <a className="link-row" href="#/safe">
                  <span>Your safe</span>
                  <Chevron />
                </a>
                <div className="link-row plain-row">
                  <span>Your address</span>
                  <Copy className="addr-copy" text={s.account} label={short(s.account)} />
                </div>
              </section>

              <section className="set">
                <h2>This device</h2>
                {bad !== null && <Failed e={bad} />}
                <button className="btn" onClick={grab}>
                  {saved ? "Downloaded. Download again" : "Download backup"}
                </button>
                <button className="btn" onClick={onLock}>
                  Lock
                </button>
                <a className="btn quiet danger-text" href="#/forget">
                  Forget this device
                </a>
              </section>
            </>
          );
        }}
      </WithSnap>
    </Screen>
  );
}

export function Forget({ onForget }: { onForget: () => void }) {
  const [saved, setSaved] = useState(false);
  const [bad, setBad] = useState<unknown>(null);
  const [ticked, setTicked] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <Screen title="Forget this device" back="/settings">
      <WithSnap>
        {(s) => (
          <>
            <p className="lead danger-lead">This removes your keys from this device. Without your backup or your paper, your money is gone for good.</p>
            {!s.hashKeyHere ? <p className="t60">Your hash key is on your phone, and stays there.</p> : <p className="t60">Your hash key is on this device, so it goes too.</p>}
            {bad !== null && <Failed e={bad} />}
            <button
              className={`btn ${saved ? "" : "primary"}`}
              onClick={() => {
                setBad(null);
                engine.backup().then(
                  (t) => {
                    download("vajra-backup.txt", t);
                    setSaved(true);
                  },
                  setBad,
                );
              }}
            >
              {saved ? "Downloaded. Download again" : "Download a fresh backup first"}
            </button>
            <label className="check">
              <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
              <span>I have my backup file and I know its passphrase.</span>
            </label>
            <label className="field">
              <span>Type FORGET to confirm</span>
              <input autoCapitalize="characters" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
            <button
              className="btn danger"
              disabled={!(saved || s.backedUp) || !ticked || typed.trim().toUpperCase() !== "FORGET"}
              onClick={() => {
                engine.forget();
                note.set("backupPending", null);
                onForget();
                go("/");
              }}
            >
              Forget this device
            </button>
          </>
        )}
      </WithSnap>
    </Screen>
  );
}
