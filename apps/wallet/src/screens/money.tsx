/** Moving money: send, receive, the private pool, the safe, and the record of it all. */
import { useEffect, useId, useRef, useState } from "react";
import type { Address, HistoryItem, PrivatePayment, SendPreview, SendResult } from "../engine-types";
import { engine } from "../wallet";
import { AddressInput, Copy, duration, eth, Failed, go, isAddr, isAmount, Loading, Proof, Qr, Screen, short, Tick, useLive, useTasks, WithSnap } from "../ui";

function AmountInput({ value, onChange, label = "Amount", balance }: { value: string; onChange: (v: string) => void; label?: string; balance?: string | null }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-with amount">
        <input id={id} inputMode="decimal" autoComplete="off" placeholder="0.00" value={value} onChange={(e) => onChange(e.target.value.replace(",", "."))} />
        <em>ETH</em>
      </div>
      {balance !== undefined && <small>You have {eth(balance)} ETH</small>}
    </div>
  );
}

export function Send({ code: startCode }: { code?: string }) {
  const { run } = useTasks();
  const [priv, setPriv] = useState(!!startCode);
  const [to, setTo] = useState("");
  const [code, setCode] = useState(startCode ?? "");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<SendPreview | "loading" | "failed" | null>(null);
  const [sent, setSent] = useState<SendResult | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (priv || !isAddr(to) || !isAmount(amount)) {
      setPreview(null);
      return;
    }
    setPreview("loading");
    const t = setTimeout(() => {
      engine.previewSend(to as Address, amount.trim()).then(
        (p) => mine === seq.current && setPreview(p),
        () => mine === seq.current && setPreview("failed"),
      );
    }, 280);
    return () => clearTimeout(t);
  }, [to, amount, priv]);

  if (sent)
    return (
      <Screen title={sent.route === "instant" ? "Sent" : "Waiting in public"}>
        <div className="result">
          <div className="row-tight">
            {sent.route === "instant" && <Tick />}
            <p className="figure">{eth(amount)} ETH</p>
          </div>
          <p className="t60">
            {sent.route === "instant" ? (
              <>It went to <span className="mono">{short(to)}</span>.</>
            ) : (
              <>It's over today's limit, so it waits in public before it can reach <span className="mono">{short(to)}</span>. It's on Home now, with a countdown.</>
            )}
          </p>
          <Proof done={sent} />
        </div>
        <a className="btn primary" href="#/">
          Back to Home
        </a>
      </Screen>
    );

  const canSend = isAmount(amount) && (priv ? code.trim().length > 0 : isAddr(to) && preview !== null && preview !== "loading" && preview !== "failed" && preview.route !== "blocked");
  const send = () => {
    if (priv)
      void run({
        title: "Sending privately",
        run: (s) => engine.sendPrivately(code.trim(), amount.trim(), s),
        result: (d) => ({ title: "Sent privately", body: "Only the person with that code can find and claim it.", done: d, action: "Back to Home" }),
      }).then((d) => {
        if (d) go("/");
      });
    else
      void run({ title: "Sending", run: (s) => engine.send(to as Address, amount.trim(), s) }).then((r) => {
        if (r) setSent(r);
      });
  };
  return (
    <Screen title="Send" back="/">
      <WithSnap>
        {(s) => (
          <>
            <div className="seg" role="tablist">
              <button role="tab" aria-selected={!priv} className={!priv ? "on" : ""} onClick={() => setPriv(false)}>
                To an address
              </button>
              <button role="tab" aria-selected={priv} className={priv ? "on" : ""} onClick={() => setPriv(true)}>
                Send privately
              </button>
            </div>
            {priv ? (
              <label className="field">
                <span>Their private code</span>
                <input className="mono-input" autoCapitalize="off" autoComplete="off" spellCheck={false} placeholder="Ask them for it" value={code} onChange={(e) => setCode(e.target.value.trim())} />
                <small>Nobody watching can tell who this payment is for.</small>
              </label>
            ) : (
              <AddressInput value={to} onChange={setTo} />
            )}
            <AmountInput value={amount} onChange={setAmount} balance={s.balance} />
            {!priv && <PreviewLine p={preview} />}
            <button className="btn primary" disabled={!canSend} onClick={send}>
              {!priv && preview && preview !== "loading" && preview !== "failed" && preview.route === "queued" ? "Send, and let it wait" : "Send"}
            </button>
          </>
        )}
      </WithSnap>
    </Screen>
  );
}

function PreviewLine({ p }: { p: SendPreview | "loading" | "failed" | null }) {
  if (p === null) return <p className="preview t60">Fill these in and you'll see what happens before you send.</p>;
  if (p === "loading") return <p className="preview t60">Checking</p>;
  if (p === "failed") return <p className="preview tone-danger-text">Can't check this right now, so what happens is unknown. Try again in a moment.</p>;
  if (p.route === "instant")
    return (
      <p className="preview">
        <strong>Goes now.</strong> <span className="t60">{eth(p.left)} ETH left today after this.</span>
      </p>
    );
  if (p.route === "queued")
    return (
      <p className="preview preview-wait">
        <strong>Waits {duration(p.delaySeconds)} in public,</strong> because it's over today's limit. You can cancel it until then.
      </p>
    );
  return <p className="preview tone-danger-text">{p.reason}</p>;
}

export function Receive() {
  const [tab, setTab] = useState<"address" | "private">("address");
  return (
    <Screen title="Receive" back="/">
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === "address"} className={tab === "address" ? "on" : ""} onClick={() => setTab("address")}>
          Address
        </button>
        <button role="tab" aria-selected={tab === "private"} className={tab === "private" ? "on" : ""} onClick={() => setTab("private")}>
          Private
        </button>
      </div>
      <WithSnap>
        {(s) =>
          tab === "address" ? (
            <>
              <Qr text={s.account} label="QR code of your address" />
              <p className="mono center">{s.account}</p>
              <Copy text={s.account} label="Copy address" className="btn primary" />
              <p className="t60 small center">Anyone who has this can see your balance. If that matters, use Private.</p>
            </>
          ) : (
            <PrivateReceive account={s.account} />
          )
        }
      </WithSnap>
    </Screen>
  );
}

function PrivateReceive({ account }: { account: Address }) {
  const { run } = useTasks();
  const [code, setCode] = useState<string | null>(null);
  const [bad, setBad] = useState<unknown>(null);
  const [list, setList] = useState<PrivatePayment[] | null>(null);
  const [scanBad, setScanBad] = useState<unknown>(null);
  const [scanning, setScanning] = useState(false);
  const scan = () => {
    setScanning(true);
    setScanBad(null);
    engine
      .scanPrivate(() => {})
      .then(setList, setScanBad)
      .finally(() => setScanning(false));
  };
  const loadCode = () => {
    setBad(null);
    engine.privateCode().then(setCode, setBad);
  };
  useEffect(() => {
    loadCode();
    scan();
  }, []);
  const link = code ? `${location.origin}/#/send?code=${encodeURIComponent(code)}` : "";
  return (
    <>
      <p className="lead">Each payment lands on a fresh address only you can find, so nobody can tie it to you.</p>
      {bad !== null ? (
        <Failed e={bad} retry={loadCode} />
      ) : code === null ? (
        <Loading what="Getting your private code" />
      ) : (
        <>
          <p className="mono code-box">{short(code)}</p>
          <Copy text={link} label="Copy link to share" className="btn primary" />
          <Copy text={code} label="Copy code only" />
        </>
      )}
      <div className="group-head">
        <h2>Payments to you</h2>
        <button className="text-btn" disabled={scanning} onClick={scan}>
          {scanning ? "Looking" : "Look again"}
        </button>
      </div>
      {scanBad !== null ? (
        <Failed e={scanBad} retry={scan} />
      ) : list === null ? (
        <Loading what="Looking through recent payments" />
      ) : list.length === 0 ? (
        <p className="t60">Nothing yet. Share your link, and payments show up here for you to claim.</p>
      ) : (
        <ul className="list">
          {list.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{eth(p.amount)} ETH</strong>
                <small>{p.claimed ? "Claimed" : "Ready to claim"}</small>
              </div>
              {!p.claimed && (
                <button
                  className="btn small"
                  onClick={() =>
                    void run({
                      title: "Claiming",
                      run: (s) => engine.claimPrivate(p.id, account, s),
                      result: (d) => ({ title: "Claimed", body: `${eth(p.amount)} ETH is in your wallet.`, done: d }),
                    }).then((d) => {
                      if (d) scan();
                    })
                  }
                >
                  Claim
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Pool() {
  const { run } = useTasks();
  const [spending, setSpending] = useState<string | null>(null);
  const [to, setTo] = useState("");
  return (
    <Screen title="Private pool" back="/" lead="Everything on a public chain can be traced. The pool breaks the trail between where money came from and where it goes.">
      <p className="honest">Your deposit is public, and so is the withdrawal. Only the link between them is hidden, and it hides better when more people use the pool.</p>
      <WithSnap>
        {(s) => {
          const live = s.notes.filter((n) => !n.spent);
          const spent = s.notes.filter((n) => n.spent);
          return (
            <>
              <button
                className="btn primary"
                onClick={() =>
                  void run({ title: "Shielding", run: (x) => engine.shield(x), result: (d) => ({ title: "Shielded", body: "Your note is in the pool. Every note is the same size, so they all look alike.", done: d }) })
                }
              >
                Shield a note
              </button>
              <div className="group-head">
                <h2>Your notes</h2>
              </div>
              {s.notes.length === 0 ? (
                <p className="t60">No notes yet. Shield one, and it waits here until you pay it out to any address.</p>
              ) : (
                <ul className="list">
                  {live.map((n) => (
                    <li key={n.id} className={spending === n.id ? "open" : ""}>
                      <div>
                        <strong>{eth(n.amount)} ETH</strong>
                        <small>Pays out {eth(n.payout)} ETH after its fee</small>
                      </div>
                      {spending === n.id ? (
                        <div className="inline-form">
                          <AddressInput label="Pay it out to" value={to} onChange={setTo} />
                          <button
                            className="btn primary"
                            disabled={!isAddr(to)}
                            onClick={() =>
                              void run({ title: "Paying out", run: (x) => engine.unshield(n.id, to as Address, x), result: (d) => ({ title: "Paid out", body: <>{eth(n.payout)} ETH went to <span className="mono">{short(to)}</span>, with no public link to your deposit.</>, done: d }) }).then((d) => {
                                if (d) {
                                  setSpending(null);
                                  setTo("");
                                }
                              })
                            }
                          >
                            Pay out
                          </button>
                        </div>
                      ) : (
                        <button className="btn small" onClick={() => setSpending(n.id)}>
                          Unshield
                        </button>
                      )}
                    </li>
                  ))}
                  {spent.map((n) => (
                    <li key={n.id} className="dim">
                      <div>
                        <strong>{eth(n.amount)} ETH</strong>
                        <small>Paid out</small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        }}
      </WithSnap>
    </Screen>
  );
}

export function Safe() {
  const { run } = useTasks();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sent, setSent] = useState<{ hash: string; explorer: string } | null>(null);
  return (
    <Screen title="Your safe" back="/">
      <WithSnap>
        {(s) => (
          <>
            {s.escaped ? <p className="lead">You escaped. A thief with your old keys can't touch anything here.</p> : <p className="lead">Where your money goes if you ever escape. It's a plain address of its own.</p>}
            <div className="hero hero-small">
              <p className={`balance ${s.safe.balance === null ? "is-unknown" : ""}`}>
                {s.safe.balance === null ? (
                  "Unknown"
                ) : (
                  <>
                    {eth(s.safe.balance)} <span>ETH</span>
                  </>
                )}
              </p>
              <Copy className="addr-copy" text={s.safe.address} label={short(s.safe.address)} />
            </div>
            {sent && (
              <p className="note-ok" role="status">
                Sent.{" "}
                <a href={sent.explorer} target="_blank" rel="noreferrer">
                  See it on the explorer
                </a>
              </p>
            )}
            {s.safe.keyHeld ? (
              Number(s.safe.balance ?? 0) > 0 || s.safe.balance === null ? (
                <>
                  <AddressInput value={to} onChange={setTo} />
                  <AmountInput value={amount} onChange={setAmount} balance={s.safe.balance} />
                  <button
                    className="btn primary"
                    disabled={!isAddr(to) || !isAmount(amount)}
                    onClick={() =>
                      void run({ title: "Sending from your safe", run: (x) => engine.sendFromSafe(to as Address, amount.trim(), x) }).then((r) => {
                        if (r) {
                          setSent(r);
                          setTo("");
                          setAmount("");
                        }
                      })
                    }
                  >
                    Send from safe
                  </button>
                </>
              ) : (
                <p className="t60">It's empty, which is how it should be until you need it.</p>
              )
            ) : (
              <p className="t60">This is an address you own, so its key isn't in this wallet. Use your own wallet to move money from it.</p>
            )}
          </>
        )}
      </WithSnap>
    </Screen>
  );
}

const HASH_KINDS = new Set<HistoryItem["kind"]>(["cancelled", "frozen", "unfreeze", "escaped", "rotated", "recovery-set", "exit-set"]);
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function Activity() {
  const { error } = useLive();
  return (
    <Screen title="Activity">
      <WithSnap>
        {(s) =>
          s.history.length === 0 ? (
            <div className="state">
              <h2>Nothing yet</h2>
              <p className="t60">Everything your wallet does shows up here, with a link to prove it.</p>
              <a className="btn" href="#/send">
                Send something
              </a>
            </div>
          ) : (
            <>
              {error != null && <p className="note-warn">Couldn't refresh. This may be out of date.</p>}
              <ul className="list activity">
                {s.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <i className={HASH_KINDS.has(h.kind) ? "by-hash" : ""} aria-hidden />
                    <div>
                      <strong>{h.text}</strong>
                      <small>{when(h.at)}</small>
                    </div>
                    {h.explorer ? (
                      <a className="text-btn" href={h.explorer} target="_blank" rel="noreferrer">
                        Proof
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="t60 small legend">
                <i className="by-hash" aria-hidden /> Your hash key did this.
              </p>
            </>
          )
        }
      </WithSnap>
    </Screen>
  );
}
