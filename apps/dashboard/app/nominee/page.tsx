"use client";

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { type QueuedView, type Rescue, type RescueCheck, type RescueDue, ETH, RescueInvalid, checkRescue, isLocalStack, parseRescue, publicClient, rescueDue, sendRescue } from "@vajra/core";
import { Lattice } from "../../components/lattice";
import { Stamp } from "../../components/stamp";
import { Term } from "../../components/term";
import { NextStep, PageHead } from "../../components/thread";
import { countdown, eth, short } from "../../lib/format";
import { NETWORKS, useReads } from "../../lib/reads";

/** The mirror makes a block every two seconds and costs nothing to read. */
const POLL_MS = isLocalStack ? 2_000 : 8_000;

const NOBODY = "0x0000000000000000000000000000000000000000";

/** A recovery sits in the queue with no recipient, and the new root where a spend's amount would be. */
const describe = (item: QueuedView) => {
  if (item.recipient === NOBODY) return <>A new master key, by a recovery proof</>;
  return (
    <>
      {item.asset === ETH ? eth(item.amount) : `${item.amount} of token ${short(item.asset)}`} to <span className="mono">{short(item.recipient)}</span>
    </>
  );
};

function Health({ check, read }: { check: RescueCheck | null; read: string | null }) {
  if (read) return <div className="banner warn">Unknown: the chain could not be read, so this page cannot say what is waiting. {read}</div>;
  if (!check) return <p className="sub">Asking the node whether this would work.</p>;
  if (check.state === "ready")
    return (
      <p className="result" data-health="ready">
        <Stamp tone="green" sub="the node says it would work now">
          Ready
        </Stamp>
      </p>
    );
  if (check.state === "sent") return null;
  if (check.state === "unknown") return <div className="banner warn" data-health="unknown">Unknown: {check.reason}</div>;
  return (
    <div className="banner error" role="alert" data-health="broken">
      This rescue would fail, so it will not be sent. {check.reason}
    </div>
  );
}

export default function NomineePage() {
  const { status, network } = useReads();
  const [rescue, setRescue] = useState<Rescue | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [check, setCheck] = useState<RescueCheck | null>(null);
  const [due, setDue] = useState<RescueDue | null>(null);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState<string | null>(null);
  const [harborHolds, setHarborHolds] = useState<bigint | null>(null);
  const inFlight = useRef(false);

  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCheck(null);
    setDue(null);
    setHarborHolds(null);
    setSendFailed(null);
    setArmed(false);
    try {
      setRescue(parseRescue(await file.text()));
      setInvalid(null);
    } catch (error) {
      setRescue(null);
      setInvalid(error instanceof RescueInvalid ? error.message : `That file could not be read: ${(error as Error).message}`);
    }
  };

  const send = useCallback(async (r: Rescue) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setSendFailed(null);
    try {
      await sendRescue(r);
    } catch (error) {
      setSendFailed((error as Error).message.slice(0, 300));
    } finally {
      inFlight.current = false;
      setSending(false);
      setArmed(false);
    }
  }, []);

  useEffect(() => {
    if (!rescue || status !== "ready") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const health = await checkRescue(rescue);
      if (!live) return;
      setCheck(health);
      if (health.state === "sent") {
        const held = await publicClient.getBalance({ address: rescue.harbor }).catch(() => null);
        if (live) setHarborHolds(held);
        return;
      }
      try {
        const next = await rescueDue(rescue);
        if (!live) return;
        setDue(next);
        setReadFailed(null);
        // Broken means it is known to fail, and a failed frame spends the nonce key for nothing. Anything else is worth a try: nothing else can stop this now.
        if (next.due && auto && health.state !== "broken") void send(rescue);
      } catch (error) {
        if (live) setReadFailed((error as Error).message.slice(0, 200));
      }
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rescue, status, auto, send]);

  const sent = check?.state === "sent" ? check : null;

  return (
    <>
      <PageHead moment={3} because="You cancel it from your phone. But what if you are not there?" title="Your nominee">
        Someone you trust holds one transaction your <Term id="hash-key" /> has already signed. It moves everything to your safe address and can do nothing else. They hold no key, and this page needs no wallet.
      </PageHead>

      <section className="plain">
        <h2>The rule</h2>
        <p className="sub">
          A theft has to wait in the <Term id="queue">public queue</Term>, and you get asked. An answer ends the wait: cancelled, or paid. So if something is still waiting close to the end, nobody answered, and the rescue goes first. The thief finds an empty, frozen account.
        </p>
      </section>

      <section className="plain">
        <h2>The rescue file</h2>
        <p className="sub">
          The owner makes it with <code>vajra exit-setup</code> and <code>vajra nominee-setup</code>. This page keeps nothing: close it and you load the file again.
        </p>
        <p className="actions">
          <input type="file" accept=".json,application/json" aria-label="Rescue file" onChange={load} data-rescue-input />
        </p>
        {invalid && (
          <div className="banner error" role="alert" data-rescue-invalid>
            {invalid}. Nothing was loaded.
          </div>
        )}
      </section>

      {rescue && (
        <>
          <section className="plain" data-rescue>
            <h2>What it does</h2>
            <dl className="facts">
              <div>
                <dt>Moves everything out of</dt>
                <dd className="mono break">{rescue.account}</dd>
              </div>
              <div>
                <dt>
                  Into the <Term id="harbor">safe address</Term>
                </dt>
                <dd className="mono break" data-harbor>
                  {rescue.harbor}
                </dd>
              </div>
              <div>
                <dt>Sent from</dt>
                <dd className="mono break">{rescue.exit}, which pays from its own reserve</dd>
              </div>
              <div>
                <dt>The most it can cost</dt>
                <dd>{eth(rescue.maxCost)}. Its fee was signed in advance and cannot be raised.</dd>
              </div>
              <div>
                <dt>It goes</dt>
                <dd>{countdown(rescue.marginSeconds)} before anything waiting would leave</dd>
              </div>
            </dl>
            <p className="sub">Holding this, you can send the owner's money to the owner's safe address and nowhere else, and you now know where that is.</p>
            <Health check={check} read={readFailed} />
          </section>

          {sent ? (
            <section className="card master" data-rescued>
              <h2>{sent.succeeded === false ? "It mined, and a frame failed" : "Rescued"}</h2>
              {sent.succeeded === false ? (
                <div className="banner error" role="alert">
                  The transaction mined and did not move the money. Tell the owner.
                </div>
              ) : (
                <p>
                  {harborHolds !== null ? `The safe address holds ${eth(harborHolds)}. ` : "What the safe address holds is unknown. "}Signed by the hash key, in advance{sent.block ? `, and mined in block ${sent.block}` : ""}.{sent.hash ? "" : " A copy of this transaction landed, with different padding."}
                </p>
              )}
              {sent.hash && <p className="sub mono break">{sent.hash}</p>}
              {sent.hash && <Lattice hash={sent.hash} label="A picture of how a hash key picks its chains, drawn from this transaction's hash. It is not the signature." />}
            </section>
          ) : (
            <section className="plain" data-watching>
              <h2>What is waiting</h2>
              {!due ? (
                <p className="sub">{readFailed ? "Unknown." : "Reading the queue."}</p>
              ) : due.waiting.length === 0 ? (
                <p className="sub" data-queue-empty>
                  Nothing is waiting{due.frozen ? ", and the account is frozen, which stops any payment from leaving" : ""}.
                </p>
              ) : (
                <>
                  {due.waiting.map((item) => (
                    <div className="item" key={item.id.toString()} data-waiting={item.id.toString()}>
                      <span>{describe(item)}</span>
                      <span className="sub">{countdown(Number(item.executeAfter) - due.now)}</span>
                    </div>
                  ))}
                  <p className="banner warn" role="status">
                    {due.due ? "Nobody answered." : `Nobody has answered yet. The rescue goes in ${countdown(due.sendIn ?? 0)}.`}
                  </p>
                </>
              )}

              <label className="check">
                <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} data-auto />
                Send it by itself if nobody answers, while this page is open
              </label>
              <p className="actions">
                {armed ? (
                  <button className="arc" disabled={sending || check?.state === "broken"} onClick={() => rescue && void send(rescue)} data-send>
                    {sending ? "Sending" : "Move everything to safety, now"}
                  </button>
                ) : (
                  <button disabled={sending || check?.state === "broken"} onClick={() => setArmed(true)} data-arm>
                    {sending ? "Sending" : "Send the rescue myself"}
                  </button>
                )}
                {armed && !sending && <button onClick={() => setArmed(false)}>Keep waiting</button>}
              </p>
              {armed && <p className="sub">This freezes the account, for good, and moves everything to the safe address. It cannot be undone. Nothing is lost by it, and the owner has to start again from there.</p>}
              {sendFailed && (
                <div className="banner error" role="alert" data-send-failed>
                  It did not go through, and this page will keep trying while it is open. {sendFailed}
                </div>
              )}
              {!isLocalStack && (
                <p className="sub">
                  Sending does not use {NETWORKS[network].label}: the transaction goes straight to the mempool, which sees your IP. Reads stay on the route chosen in the menu.
                </p>
              )}
            </section>
          )}
        </>
      )}

      <section className="plain">
        <h2>What this does not do</h2>
        <ul className="sub">
          <li>It only watches while this page is open. For something always on, the holder runs <code>vajra nominee-watch</code>, which also holds no key. Two holders are better than one.</li>
          <li>A spend under the daily limit leaves at once, so it never waits here. A thief still gets a day's limit, each day, until you come back.</li>
          <li>It cannot tell you from a thief. A real payment of yours that you leave unanswered sets it off too, so every queued payment needs an answer.</li>
          <li>If the owner changes the safe address or the exit's keys, this file stops working, and they have to sign a new one.</li>
        </ul>
      </section>

      <NextStep href="/mempool" label="The thief cannot break the rules, so they block your exit" why="Why this rescue still gets through, whatever the thief has pending." />
    </>
  );
}
