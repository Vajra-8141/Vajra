"use client";

import { useCallback, useEffect, useState } from "react";
import { FirstRun } from "../../components/checklist";
import { Stamp } from "../../components/stamp";
import { Term } from "../../components/term";
import { NextStep, PageHead } from "../../components/thread";
import { useAccount } from "../../lib/account";
import { type AttackGroup, type AttackInfo, type AttackResult, attackList, runAttack } from "../../lib/bridge";
import { REFUSALS, short } from "../../lib/format";

const GROUPS: [AttackGroup, string, string][] = [
  ["rank", "Reach past its rank", "The thief holds the daily key and asks for what only the hash key may do."],
  ["shape", "Bend the transaction", "The thief keeps inside the daily key's rank and tries to smuggle something through the frames."],
  ["outsider", "No key at all", "Someone without the daily key tries to pass as it."],
];

function Verdict({ result }: { result: AttackResult }) {
  if (result.outcome === "not-run") return <p className="result">Not run. {result.note}</p>;
  if (result.outcome === "admitted") {
    return (
      <div className="banner error" role="alert">
        ADMITTED. The mempool took this attack{result.hash ? ` as ${short(result.hash)}` : ""}. That is a bug in VAJRA, and this page will not hide it. {result.note}
      </div>
    );
  }
  const name = result.refusal ?? "unknown";
  const named = name.length <= 34;
  return (
    <div className="verdict">
      <Stamp tone={result.asClaimed ? "red" : "saffron"} sub={result.outcome === "stopped" ? "refused by the contract" : "refused by the alt mempool"} exact={named}>
        {named ? name : "Refused"}
      </Stamp>
      <div className="verdict-text">
        {!result.asClaimed && <p className="result bad">Refused, but not for the reason claimed. The rulebook expects {result.expected}.</p>}
        {REFUSALS[name] && <p className="sub">{REFUSALS[name]}</p>}
        {!named && <p className="sub break">{name}</p>}
        {result.note && <p className="sub">{result.note}</p>}
        {result.steps.map((step) => (
          <p className="sub" key={step}>
            Set up: {step}.
          </p>
        ))}
        <details>
          <summary>Raw answer{result.code !== null ? `, code ${result.code}` : ""}, {result.ms} ms</summary>
          <pre className="raw">{result.raw}</pre>
          {result.failedRule && (
            <p className="sub">
              Sidecar rule that failed: <code>{result.failedRule.rule}</code>
            </p>
          )}
          {result.hash && <p className="sub mono break">Transaction {result.hash}, never admitted</p>}
        </details>
      </div>
    </div>
  );
}

export default function BreakInPage() {
  const { health, account, refreshChain, refreshBridge } = useAccount();
  const [list, setList] = useState<AttackInfo[] | null>(null);
  const [results, setResults] = useState<Record<string, AttackResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const demo = health?.demo.available === true;

  useEffect(() => {
    if (!demo) return;
    attackList().then(
      (answer) => {
        setList(answer.attacks);
        setResults(answer.results);
      },
      (e: Error) => setProblem(e.message),
    );
  }, [demo, account]);

  const fire = useCallback(async (id: string) => {
    const result = await runAttack(id);
    setResults((known) => ({ ...known, [id]: result }));
  }, []);

  async function one(id: string) {
    setBusy(id);
    setProblem(null);
    try {
      await fire(id);
      await refreshBridge();
      await refreshChain();
    } catch (e) {
      setProblem((e as Error).message);
    }
    setBusy(null);
  }

  async function all() {
    setProblem(null);
    try {
      for (const attack of list ?? []) {
        setBusy(attack.id);
        await fire(attack.id);
      }
      await refreshBridge();
      await refreshChain();
    } catch (e) {
      setProblem((e as Error).message);
    }
    setBusy(null);
  }

  const seen = Object.values(results);
  const stopped = seen.filter((r) => r.outcome === "refused" || r.outcome === "stopped").length;
  const admitted = seen.filter((r) => r.outcome === "admitted").length;

  return (
    <div className="stack">
      <PageHead moment={3} because="the hash key outranks the wallet, so the thief goes after the rules" title="Try to break in">
        Each button signs a real attack with the stolen <Term id="daily-key" /> and sends it through the bridge to the <Term id="alt-mempool" />. What you see is what the mempool answered. These are the same attacks <code>vajra e2e</code> runs.
      </PageHead>
      <FirstRun />
      {health && !demo && <div className="banner warn">This panel needs the demo signer, which exists on the local mirror only{health.demo.reason ? `: ${health.demo.reason}` : ""}.</div>}
      {problem && <div className="banner error">{problem}</div>}

      {list && (
        <>
          <div className="tally" aria-live="polite">
            <span>
              <strong>{seen.length}</strong> of {list.length} tried
            </span>
            <span>
              <strong>{stopped}</strong> stopped
            </span>
            <span className={admitted ? "bad" : ""}>
              <strong>{admitted}</strong> got in
            </span>
            <button className="primary" disabled={!!busy} onClick={all}>
              {busy ? "Running…" : "Run every attack"}
            </button>
          </div>

          {GROUPS.map(([group, title, plain]) => (
            <section className="attacks" key={group} aria-label={title}>
              <h2>{title}</h2>
              <p className="sub">{plain}</p>
              {list
                .filter((a) => a.group === group)
                .map((attack) => (
                  <article className="attack" key={attack.id} data-attack={attack.id}>
                    <div className="attack-head">
                      <div>
                        <h3>{attack.plain}</h3>
                        <p className="sub">{attack.takes ? `Takes ${attack.takes}.` : ""}</p>
                      </div>
                      <button disabled={!!busy} onClick={() => one(attack.id)}>
                        {busy === attack.id ? "Sending…" : results[attack.id] ? "Try again" : "Try it"}
                      </button>
                    </div>
                    {results[attack.id] && <Verdict result={results[attack.id]!} />}
                  </article>
                ))}
            </section>
          ))}
        </>
      )}
      <NextStep href="/mempool" label="The thief cannot break the rules, so they block your exit" why="See one signed transaction offered to both mempools." />
    </div>
  );
}
