"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isLocalStack } from "@vajra/core";
import { Cheque } from "../components/cheque";
import { FirstRun } from "../components/checklist";
import { Phone } from "../components/phone";
import { Stamp } from "../components/stamp";
import { Term } from "../components/term";
import { useAccount } from "../lib/account";
import { type AttackResult, type DemoSpend, attackList, demoReset, demoSpend, demoThief, master, runAttack } from "../lib/bridge";
import { REFUSALS, eth, explain, short } from "../lib/format";

/** Somebody the owner pays. Any address would do: this one is easy to recognise in a block explorer. */
const SHOP = "0x000000000000000000000000000000000000c0de";
const EVERYDAY = "0.005";
const THEFT = "0.5";

function Step({ n, done, current, title, children }: { n: number; done: boolean; current: boolean; title: string; children: ReactNode }) {
  return (
    <li className={`step ${done ? "done" : ""} ${current ? "current" : ""}`} data-step={n} aria-current={current ? "step" : undefined}>
      <span className="step-mark" aria-hidden>
        {done ? "✓" : n}
      </span>
      <div className="step-body">
        <h3>
          <span className="visually-hidden">
            Step {n}
            {done ? ", done" : ""}:{" "}
          </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}

export default function StoryPage() {
  const { bridge, health, account, chain, now, lastMaster, refreshBridge, refreshChain, setLastDaily, setLastMaster, countOperation } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [everyday, setEveryday] = useState<DemoSpend | null>(null);
  const [theft, setTheft] = useState<DemoSpend | null>(null);
  const [outranked, setOutranked] = useState<AttackResult | null>(null);
  const [veto, setVeto] = useState<{ hash: string; gas: number } | null>(null);
  const [escaped, setEscaped] = useState<{ hash: string; gas: number } | null>(null);
  const [arming, setArming] = useState(false);

  const demo = health?.demo.available === true;

  // The bridge remembers an attack it ran, so a reload keeps this tick honest instead of forgetting it.
  useEffect(() => {
    if (!demo) return;
    attackList().then(
      ({ results }) => setOutranked((known) => known ?? results.rotate ?? null),
      () => {},
    );
  }, [demo, account]);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setProblem(null);
    try {
      await work();
      await refreshChain();
    } catch (e) {
      setProblem(explain(e));
    }
    setBusy(null);
  }

  const items = chain?.items ?? [];
  const latest = items.length ? items[items.length - 1]! : null;
  const pending = latest?.state === 1;
  const cancelled = latest?.state === 3;
  const paidOut = latest?.state === 2;

  // On a phone the alert sits above the steps, and the theft has just scrolled it out of sight. It has to wait for the queued item: with
  // only a blank cheque the exhibit is display: none, and scrolling to it then does nothing.
  const showAlert = useRef(false);
  useEffect(() => {
    if (!showAlert.current || !pending) return;
    showAlert.current = false;
    if (window.matchMedia("(max-width: 1020px)").matches) document.querySelector(".exhibit")?.scrollIntoView({ block: "start" });
  }, [pending, latest?.id]);
  const emptied = chain !== null && chain.frozen && chain.balance < 10n ** 16n;

  const ticks = [
    chain !== null,
    chain !== null && (chain.spent > 0n || everyday !== null),
    latest !== null,
    latest !== null,
    cancelled,
    outranked !== null && outranked.outcome === "refused",
  ];
  // A waiting payment is the only thing that matters while it waits, so it takes the highlight from anything skipped.
  const current = pending ? 4 : ticks.findIndex((tick) => !tick);
  const ready = bridge !== null && bridge !== "down" && account !== null;

  const pay = () =>
    run("pay", async () => {
      const spent = await demoSpend(SHOP, EVERYDAY);
      setEveryday(spent);
      setLastDaily({ gas: spent.verifyGas, hash: spent.hash });
    });
  const steal = () =>
    run("steal", async () => {
      showAlert.current = true;
      const spent = await demoThief(THEFT);
      setTheft(spent);
      setVeto(null);
      setLastDaily({ gas: spent.verifyGas, hash: spent.hash });
    });
  const cancel = () =>
    run("cancel", async () => {
      const result = await master({ op: "veto", id: latest!.id.toString() });
      setVeto({ hash: result.hash, gas: result.verifyGas });
      setLastMaster({ hash: result.hash, gas: result.verifyGas });
      await refreshBridge();
      countOperation();
    });
  const outrank = () => run("outrank", async () => setOutranked(await runAttack("rotate")));
  const escape = () =>
    run("escape", async () => {
      const result = await master({ op: "escape" });
      setEscaped({ hash: result.hash, gas: result.verifyGas });
      setLastMaster({ hash: result.hash, gas: result.verifyGas });
      setArming(false);
      await refreshBridge();
      countOperation();
    });
  const startOver = () =>
    run("reset", async () => {
      await demoReset();
      setEveryday(null);
      setTheft(null);
      setOutranked(null);
      setVeto(null);
      setEscaped(null);
      await refreshBridge();
    });

  const noDemoSigner = !demo && (
    <p className="sub">
      {isLocalStack ? `The demo signer is not available: ${health?.demo.reason ?? "the bridge has not answered"}.` : "The demo signer exists on the local mirror only."} Sign this step with your wallet on the <Link href="/account">Account page</Link>.
    </p>
  );

  return (
    <div className="story">
      <div className="hero">
        <h1>Someone stole your wallet key. Here is everything they get.</h1>
        <p className="lead">
          You keep your <Term id="wallet" />. A stolen key gets a <Term id="daily-limit" />. A big payment waits in a <Term id="queue">public queue</Term>, your phone gets an alert, and one tap cancels it, because a <Term id="hash-key" /> outranks the wallet.
        </p>
      </div>

      <FirstRun />

      {ready && demo && (
        <div className="demo-note">
          <strong>Demo signer.</strong> The bridge is signing as the <Term id="daily-key" /> with the <Term id="mirror" />&apos;s throwaway key <span className="mono">{short(health!.demo.dailyKey!)}</span>, so you need no wallet. It is not your wallet, and it is not offered on the public chain. Every transaction below is real, on this mirror.
        </div>
      )}
      {problem && <div className="banner error">{problem}</div>}

      {ready && (
        <div className="story-grid">
          <ol className="steps">
            <Step n={1} done={ticks[0]!} current={current === 0} title="You keep your wallet, and it gets rules">
              {chain ? (
                <p>
                  This account holds <strong>{eth(chain.balance)}</strong>. Its <Term id="daily-key" /> can send {eth(chain.limit)} a day, and {eth(chain.allowance)} to a payee it has never paid, which is called <Term id="cooling">new-payee cooling</Term>. These figures are read from the chain.
                </p>
              ) : (
                <p className="sub">Reading the account from the chain…</p>
              )}
            </Step>

            <Step n={2} done={ticks[1]!} current={current === 1} title="Everyday spending just works">
              <p>A payment inside the rules goes straight out, signed by the daily key and carried by the <Term id="alt-mempool" />.</p>
              {demo ? (
                <button className={current === 1 ? "primary" : ""} disabled={!!busy || !chain} onClick={pay}>
                  {busy === "pay" ? "Sending…" : `Pay the shop ${EVERYDAY} ETH`}
                </button>
              ) : (
                noDemoSigner
              )}
              {everyday && (
                <p className="result">
                  Mined in block {everyday.block}, {everyday.verifyGas.toLocaleString()} gas to verify. {everyday.queued ? `Queued as item ${everyday.queued.id}.` : "No wait."}
                </p>
              )}
            </Step>

            <Step n={3} done={ticks[2]!} current={current === 2} title="A thief steals the key and goes for everything">
              <p>The thief holds the same key you do, so the chain cannot tell you apart. The rules can still hold them to the limit.</p>
              {demo ? (
                <button className={current === 2 ? "primary" : ""} disabled={!!busy || !chain || pending} onClick={steal}>
                  {busy === "steal" ? "Stealing…" : latest ? `Steal ${THEFT} ETH again` : `Steal ${THEFT} ETH as the thief`}
                </button>
              ) : (
                noDemoSigner
              )}
              {theft?.queued && (
                <p className="result">
                  Not refused, and not paid. Over the limit, so it was mined into the queue as item {theft.queued.id}, in block {theft.block}.
                </p>
              )}
              {theft && !theft.queued && <p className="result bad">The chain paid this out without queueing it.</p>}
            </Step>

            <Step n={4} done={ticks[3]!} current={current === 3} title="Your phone gets an alert">
              <p>The queue is public, so a watcher can see the payment the moment it lands. The thief cannot hide it.</p>
            </Step>

            <Step n={5} done={ticks[4]!} current={current === 4} title="One tap cancels it">
              <p>
                <q>Not me, cancel</q> asks the <Term id="bridge" /> for a <Term id="veto" />, signed by the hash key with one <Term id="one-time-key" />.
              </p>
              {paidOut && <p className="result bad">The delay ran out and this one was executed. Steal again to try once more.</p>}
              {latest?.state === 1 && Number(latest.executeAfter) <= now && <p className="result">The delay is over and nobody has executed it. You can still cancel it.</p>}
              {cancelled && veto && (
                <p className="result">
                  Cancelled by <span className="mono">{short(veto.hash)}</span>, {veto.gas.toLocaleString()} gas to verify. The money did not move.
                </p>
              )}
              {cancelled && !veto && lastMaster && <p className="result">Cancelled on chain.</p>}
            </Step>

            <Step n={6} done={ticks[5]!} current={current === 5} title="The hash key outranks the wallet">
              <p>So the thief tries to replace your hash key with their own, signed with the stolen key. This goes to the alt mempool for real.</p>
              {demo ? (
                <button className={current === 5 ? "primary" : ""} disabled={!!busy || !chain} onClick={outrank}>
                  {busy === "outrank" ? "Trying…" : "Replace the hash key as the thief"}
                </button>
              ) : (
                noDemoSigner
              )}
              {outranked && outranked.outcome === "refused" && (
                <div className="refused-line">
                  <Stamp tone="red" sub="refused by the alt mempool" exact>
                    {outranked.refusal}
                  </Stamp>
                  <p className="sub">{REFUSALS[outranked.refusal ?? ""] ?? outranked.raw}</p>
                </div>
              )}
              {outranked && outranked.outcome !== "refused" && <p className="result bad">The mempool did not refuse this: {outranked.outcome}.</p>}
            </Step>
          </ol>

          <aside className="exhibit" aria-label="The payment and the phone">
            <Cheque account={account} item={latest} now={now} veto={veto} />
            <Phone item={latest} now={now} busy={busy === "cancel"} onCancel={cancel} />
          </aside>
        </div>
      )}

      {ready && ticks.every(Boolean) && (
        <section className="after" aria-labelledby="after">
          <h2 id="after">That is the story. Now try to prove it wrong.</h2>
          <div className="after-links">
            <Link className="button primary" href="/break-in">
              Try to break in
            </Link>
            <Link className="button" href="/mempool">
              Compare the two mempools
            </Link>
            <Link className="button" href="/lifecycle">
              Watch the lifecycle
            </Link>
          </div>
        </section>
      )}

      {ready && demo && (
        <section className="endgame" aria-labelledby="endgame">
          <h2 id="endgame">The last resort</h2>
          <p>
            <Term id="escape">Escape</Term> sends the whole balance to your sealed <Term id="harbor" /> and freezes the account for good. A thief cannot stop it. This ends this demo account.
          </p>
          {escaped && (
            <p className="result">
              Escaped in <span className="mono">{short(escaped.hash)}</span>, {escaped.gas.toLocaleString()} gas to verify.
            </p>
          )}
          <div className="actions">
            {!emptied &&
              (arming ? (
                <>
                  <button className="danger armed" disabled={!!busy} onClick={escape}>
                    {busy === "escape" ? "Escaping…" : "Confirm escape"}
                  </button>
                  <button onClick={() => setArming(false)}>Keep the account</button>
                </>
              ) : (
                <button className="danger" disabled={!!busy || !chain} onClick={() => setArming(true)}>
                  Escape to harbor
                </button>
              ))}
            <button disabled={!!busy} onClick={startOver}>
              {busy === "reset" ? "Creating…" : "Start over with a new account"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
