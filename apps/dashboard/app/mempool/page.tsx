"use client";

import { useEffect, useState } from "react";
import { FirstRun } from "../../components/checklist";
import { Stamp } from "../../components/stamp";
import { Term } from "../../components/term";
import { NextStep, PageHead } from "../../components/thread";
import { useAccount } from "../../lib/account";
import { type ExperimentInfo, type FrameRow, type LabResult, type Lane, labList, runLab } from "../../lib/bridge";
import { gas } from "../../lib/format";

const LANE_NAMES = { canonical: "Canonical mempool", alt: "Alt mempool" };

function LaneColumn({ lane }: { lane: Lane }) {
  return (
    <div className="lane" data-lane={lane.name}>
      <h3>{lane.name === "canonical" ? <Term id="canonical-mempool">{LANE_NAMES.canonical}</Term> : <Term id="alt-mempool">{LANE_NAMES.alt}</Term>}</h3>
      <p className="sub mono">{lane.route}</p>
      <Stamp tone={lane.verdict === "admitted" ? "green" : "red"}>{lane.verdict}</Stamp>
      {lane.raw ? (
        <>
          <p className="sub">Raw error, code {lane.code}, in {lane.ms} ms</p>
          <pre className="raw">{lane.raw}</pre>
        </>
      ) : (
        <p className="sub">No error, in {lane.ms} ms.</p>
      )}
      {lane.mined && (
        <p className="result">
          Mined in block {lane.mined.block}
          {lane.mined.ok ? ", all frames ok." : ", but a frame failed."}
        </p>
      )}
      {lane.verdict === "admitted" && !lane.mined && <p className="sub">Not seen in a block within 30 seconds.</p>}
    </div>
  );
}

/** One scale for every bar in a result, so that a limit can be compared with the 100,000 line by eye. */
function FrameBar({ frame, scale, cap }: { frame: FrameRow; scale: bigint; cap: bigint }) {
  const share = (value: bigint) => `${Number((value * 10000n) / scale) / 100}%`;
  const limit = BigInt(frame.limit);
  const verify = frame.kind === "VERIFY";
  return (
    <div className={`frame ${verify ? "verify" : ""}`} data-frame={frame.index}>
      <div className="frame-text">
        <span>
          Frame {frame.index}, {verify ? <Term id="verify-frame">VERIFY</Term> : frame.kind === "SENDER" ? <Term id="sender-frame">SENDER</Term> : frame.kind}
        </span>
        <span className="frame-numbers">
          {frame.used === null ? "gas used unknown" : `${gas(frame.used)} used`} of {gas(frame.limit)} declared
          {frame.source === "simulation" ? ", simulated, not mined" : ""}
          {frame.status === "failed" ? ", failed" : ""}
        </span>
      </div>
      <div className="bar" role="img" aria-label={`Declared ${gas(frame.limit)} gas, used ${frame.used === null ? "unknown" : gas(frame.used)}`}>
        <span className="bar-limit" style={{ width: share(limit) }} />
        {frame.used !== null && <span className="bar-used" style={{ width: share(BigInt(frame.used)) }} />}
        {verify && <span className="bar-cap" style={{ left: share(cap) }} />}
      </div>
    </div>
  );
}

function Result({ result }: { result: LabResult }) {
  const cap = BigInt(result.cap);
  const scale = result.frames.reduce((top, f) => (BigInt(f.limit) > top ? BigInt(f.limit) : top), cap);
  return (
    <div className="lab-result">
      <dl className="facts">
        <div>
          <dt>Transaction</dt>
          <dd className="mono break">{result.hash}</dd>
        </div>
        <div>
          <dt>Keccak of the signed bytes</dt>
          <dd className="mono break">{result.bytes.keccak}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{result.bytes.size.toLocaleString()} bytes</dd>
        </div>
        <div>
          <dt>Sender</dt>
          <dd>
            <span className="mono break">{result.sender}</span>, {result.staked === null ? "stake unknown" : result.staked ? "staked" : "not staked"}
          </dd>
        </div>
      </dl>
      <p className="sub">One signed transaction, offered to the canonical mempool first and then to the alt mempool. ethrex takes it as raw bytes and the sidecar as JSON, and both hash it to the value above.</p>

      <div className="lanes">
        {result.lanes.map((lane) => (
          <LaneColumn key={lane.name} lane={lane} />
        ))}
      </div>

      <h3>Gas per frame</h3>
      <div className="frames">
        {result.frames.map((frame) => (
          <FrameBar key={frame.index} frame={frame} scale={scale} cap={cap} />
        ))}
      </div>
      <p className="sub">
        Both mempools measure what a frame declares, not what it spends. Pale is declared, dark is used, and the red line is {gas(result.cap)}. The VERIFY frames declare {gas(result.verifyLimit)} in all, before the signature cost is added.
      </p>
      {result.simulation.violation && (
        <p className="sub">
          ethrex&apos;s simulator agreed before sending: <code>{result.simulation.violation}</code>
        </p>
      )}
      {result.notes.map((note) => (
        <p className="sub break" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}

export default function MempoolPage() {
  const { health, account } = useAccount();
  const [list, setList] = useState<ExperimentInfo[] | null>(null);
  const [results, setResults] = useState<Record<string, LabResult>>({});
  const [chosen, setChosen] = useState("pin");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const demo = health?.demo.available === true;

  useEffect(() => {
    if (!demo) return;
    labList().then(
      (answer) => {
        setList(answer.experiments);
        setResults(answer.results);
      },
      (e: Error) => setProblem(e.message),
    );
  }, [demo, account]);

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await runLab(chosen);
      setResults((known) => ({ ...known, [chosen]: result }));
    } catch (e) {
      setProblem((e as Error).message);
    }
    setBusy(false);
  }

  const experiment = list?.find((e) => e.id === chosen);
  const result = results[chosen];

  return (
    <div className="stack">
      <PageHead moment={4} because="the thief blocks your exit, so there is a second way in" title="One transaction, two mempools">
        The same signed <Term id="frame-transaction" /> goes to the <Term id="canonical-mempool" /> and the <Term id="alt-mempool" />, side by side, and each answers in its own words. This reuses <code>vajra pin</code> and <code>vajra budget</code>.
      </PageHead>
      <FirstRun />
      {health && !demo && <div className="banner warn">These experiments run on the local mirror only{health.demo.reason ? `: ${health.demo.reason}` : ""}.</div>}
      {problem && <div className="banner error">{problem}</div>}

      <aside className="note-box" aria-label="Where the gas limits are">
        <h2>Which limit is which</h2>
        <ul>
          <li>The canonical path, in ethrex, still refuses a validation prefix over 100,000 gas.</li>
          <li>
            This mirror&apos;s patched <Term id="sidecar" /> keeps budgets per entity: 100,000 unstaked, 1,000,000 with a <Term id="stake" />.
          </li>
          <li>The public alt mempool no longer has a gas cap. So a budget refusal from the alt side here comes from this mirror&apos;s sidecar. This page never sends anything to the public mempool, and it did not test that.</li>
        </ul>
      </aside>

      {list && (
        <div className="lab">
          <div className="lab-list" role="radiogroup" aria-label="Experiment">
            {list.map((e) => (
              <button key={e.id} role="radio" aria-checked={e.id === chosen} className={e.id === chosen ? "chosen" : ""} disabled={busy} onClick={() => setChosen(e.id)}>
                {e.title}
              </button>
            ))}
          </div>
          <div className="lab-main">
            {experiment && (
              <>
                <p>{experiment.plain}</p>
                <button className="primary" disabled={busy} onClick={run}>
                  {busy ? "Sending to both…" : result ? "Run it again" : "Send to both mempools"}
                </button>
                <span className="sub lab-takes"> Takes {experiment.takes}.</span>
              </>
            )}
            {result && <Result result={result} />}
          </div>
        </div>
      )}
      <NextStep href="/lifecycle" label="What happened to each transaction" why="Follow every one from new to mined or cancelled, in the sidecar's own records." />
    </div>
  );
}
