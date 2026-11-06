"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { isLocalStack } from "@vajra/core";
import { useAccount } from "../lib/account";
import { type AttackResult, type DemoSpend, attackList, demoReset, demoSpend, demoThief, master, runAttack } from "../lib/bridge";
import { REFUSALS, eth, explain, short } from "../lib/format";
import { Cheque } from "./cheque";
import { FirstRun } from "./checklist";
import { Phone } from "./phone";
import { Stamp } from "./stamp";
import { Term } from "./term";
import { MOMENTS } from "./thread";
import type { ThreadFacts } from "./thread-facts";

/** Somebody the owner pays. Any address would do: this one is easy to recognise in a block explorer. */
const SHOP = "0x000000000000000000000000000000000000c0de";
const EVERYDAY = "0.005";
const THEFT = "0.5";

function Step({ n, done, current, title, children }: { n: number; done: boolean; current: boolean; title: string; children: ReactNode }) {
  return (
    <li className={`step ${done ? "done" : ""} ${current ? "current" : ""}`} data-step={n} aria-current={current ? "step" : undefined}>
      <span className="step-mark" aria-hidden>
        {done && <Check size={14} strokeWidth={3} />}
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

function Moment({ n, then, children }: { n: number; then?: string; children: ReactNode }) {
  return (
    <section className="moment" id={`moment-${n}`} aria-labelledby={`moment-${n}-title`}>
      <h2 id={`moment-${n}-title`}>
        <span className="moment-n">{n}</span>
        {MOMENTS[n - 1]!.title}
      </h2>
      {children}
      {then && <p className="then">{then}</p>}
    </section>
  );
}

/** A moment that needs a terminal: told here, with what was recorded and the command that repeats it. */
function Recorded({ n, then, where, limit, command, children }: { n: number; then?: string; where: string; limit: string; command: string; children: ReactNode }) {
  return (
    <Moment n={n} then={then}>
      <p>{children}</p>
      <dl className="recorded">
        <div>
          <dt>Recorded</dt>
          <dd>{where}</dd>
        </div>
        <div>
          <dt>What it does not do</dt>
          <dd>{limit}</dd>
        </div>
        <div>
          <dt>Run it yourself</dt>
          <dd>
            <code>{command}</code>
          </dd>
        </div>
      </dl>
      <Link className="quiet" href="/proof">
        Open the record
      </Link>
    </Moment>
  );
}

export function Story({ facts }: { facts: ThreadFacts }) {
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
    if (window.matchMedia("(max-width: 1180px)").matches) document.querySelector(".exhibit")?.scrollIntoView({ block: "start" });
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

  const threadDone = [ticks[0]! && ticks[1]!, ticks[2]! && ticks[3]!, ticks[4]! && ticks[5]!, escaped !== null || emptied];
  const nextMoment = threadDone.findIndex((done) => !done);

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

      <nav className="threadbar" aria-label="The seven moments">
        <ol>
          {MOMENTS.map((moment, i) => {
            const done = threadDone[i] === true;
            return (
              <li key={moment.n} className={`${done ? "done" : ""} ${ready && i === nextMoment ? "current" : ""} ${i > 3 ? "later" : ""}`}>
                <a href={`#moment-${moment.n}`}>
                  <span className="threadbar-dot">{done ? <Check size={12} strokeWidth={3} aria-hidden /> : moment.n}</span>
                  <span className="threadbar-label">{moment.short}</span>
                </a>
              </li>
            );
          })}
        </ol>
      </nav>

      {ready && (
        <div className="story-grid">
          <div className="moments">
            <Moment n={1} then="Nothing about daily life changes. But the key that spends is also the key a thief can steal.">
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
                    <button className={current === 1 ? "primary" : ""} disabled={!!busy || !chain} aria-busy={busy === "pay"} onClick={pay}>
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
              </ol>
            </Moment>

            <Moment n={2} then="The theft is public and it has to wait. That wait is what lets you answer.">
              <ol className="steps">
                <Step n={3} done={ticks[2]!} current={current === 2} title="A thief steals the key and goes for everything">
                  <p>The thief holds the same key you do, so the chain cannot tell you apart. The rules can still hold them to the limit.</p>
                  {demo ? (
                    <button className={current === 2 ? "primary" : ""} disabled={!!busy || !chain || pending} aria-busy={busy === "steal"} onClick={steal}>
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
              </ol>
            </Moment>

            <Moment n={3} then="So the thief stops trying to spend, and goes after your way out.">
              <ol className="steps">
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
                    <button className={current === 5 ? "primary" : ""} disabled={!!busy || !chain} aria-busy={busy === "outrank"} onClick={outrank}>
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
            </Moment>

            <Moment n={4}>
              <p>
                The thief keeps a transaction pending, and the <Term id="canonical-mempool" /> will not hold your <Term id="escape" /> next to it. The <Term id="alt-mempool" /> keeps the two apart, so the same signed bytes get through. That is why it has to exist. It lasts for as long as the thief keeps a transaction pending.
              </p>
              <Link className="quiet" href="/mempool">
                See one transaction offered to both
              </Link>
              {demo ? (
                <section className="endgame" aria-labelledby="endgame">
                  <h3 id="endgame">The last resort</h3>
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
                          <button className="danger armed" disabled={!!busy} aria-busy={busy === "escape"} onClick={escape}>
                            {busy === "escape" ? "Escaping…" : "Confirm escape"}
                          </button>
                          <button onClick={() => setArming(false)}>Keep the account</button>
                        </>
                      ) : (
                        <button className="danger" disabled={!!busy || !chain} onClick={() => setArming(true)}>
                          Escape to harbor
                        </button>
                      ))}
                    <button disabled={!!busy} aria-busy={busy === "reset"} onClick={startOver}>
                      {busy === "reset" ? "Creating…" : "Start over with a new account"}
                    </button>
                  </div>
                </section>
              ) : (
                <p className="sub">
                  Escape needs the hash key, and it ends the account. It is on the <Link href="/account">Account page</Link>.
                </p>
              )}
            </Moment>
          </div>

          <aside className="exhibit" aria-label="The payment and the phone">
            <Cheque account={account} item={latest} now={now} veto={veto} />
            <Phone item={latest} now={now} busy={busy === "cancel"} onCancel={cancel} />
          </aside>
        </div>
      )}

      <div className="told">
        <p className="told-note">The rest of the thread needs a terminal, so here it is told, with what was recorded and the command that repeats it.</p>
        <Recorded n={5} then="Your money is safe and your receipts are private. The one thing left to lose is the master key itself." where={`Public devnet, chain ${facts.stealth.chainId}, after the reset.`} limit="It is not safe against a sender who also owns a quantum computer." command="vajra stealth">
          Someone pays you, and nobody can link the payment to you. It arrives through an ML-KEM-768 announcement, then is spent with a hash signature and a co-signature, with gas paid by a paymaster and no ETH anywhere.
        </Recorded>
        <Recorded n={6} then="And once the keys are safe, you want somewhere private to keep savings, without giving up the rules." where={`Public devnet, chain ${facts.recovery.chainId}: ${facts.recovery.mined} mined, ${facts.recovery.refused} refused, ${facts.recovery.gas.toLocaleString("en-US")} gas to verify the proof.`} limit="Groth16 is not post-quantum, so this path is weaker than the key it replaces. The trusted setup has one contributor, us." command="vajra recover">
          A proof of a secret you keep on paper queues a new key tree. It goes through the same public queue as a big payment, so if the paper was stolen, the master key can still cancel it.
        </Recorded>
        <Recorded n={7} where={`On the mirror, chain ${facts.pool.chainId}: ${facts.pool.mined} mined, ${facts.pool.refused} refused. One note in and out on the public devnet.`} limit="The pool hides which deposit paid, not that this account paid that recipient. The public run held one note, so it proves the path, not any privacy." command="vajra shielded">
          Fixed-size notes inside the account, spent with a proof and no key. A freeze blocks a withdrawal, an escape drains the pool to your harbor, and the daily key cannot reach it at all.
        </Recorded>
      </div>

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
    </div>
  );
}
