"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { DEVNET, type RpcCall, isLocalStack, rpc, rpcBatch } from "@vajra/core";
import { Stamp, type StampTone } from "../../components/stamp";
import { Term } from "../../components/term";
import { useAccount } from "../../lib/account";
import { type RaceResult, runRace } from "../../lib/bridge";
import { short } from "../../lib/format";

const POLL_MS = 3_000;
const SHOWN = 25;

interface Check {
  rule: string;
  verdict: string;
  detail?: string;
}

interface Admission {
  txHash: string;
  sender: string;
  at: number;
  outcome: "rejected" | "accepted" | "included" | "replaced" | "dropped";
  errorCode?: number;
  checks: Check[];
}

interface LifeEvent {
  seq: number;
  at: number;
  kind: "admitted" | "rejected" | "replaced" | "statusChanged" | "dropped" | "included";
  status?: string;
  reason?: string;
  blockNumber?: number;
}

interface Detail {
  entry: { status: string; revertReason?: string } | null;
  events: LifeEvent[];
}

interface Reputation {
  address: string;
  opsSeen: number;
  opsIncluded: number;
  status: "ok" | "throttled" | "banned";
  stake: string;
  unstakeDelaySec: number;
  isStaked: boolean;
}

interface Info {
  minInclusionDenominator: number;
  throttlingSlack: number;
  banSlack: number;
  version: string;
  bundlingMode: string;
}

type End = { label: string; tone: StampTone; reason: string | null };

/** Where a transaction finished, in the sidecar's words. Nothing here is inferred from a missing record. */
function ending(a: Admission, d: Detail | undefined): End | null {
  const dropped = d?.events.find((e) => e.kind === "dropped");
  if (a.outcome === "included") return { label: "Mined", tone: "green", reason: null };
  // No detail yet means not read yet, which says nothing about what the sidecar recorded.
  if (a.outcome === "dropped") return { label: "Cancelled", tone: "red", reason: d ? (dropped?.reason ?? d.entry?.revertReason ?? "the sidecar gave no reason") : null };
  if (a.outcome === "replaced") return { label: "Replaced", tone: "saffron", reason: d ? (d.events.find((e) => e.kind === "replaced")?.reason ?? "a newer transaction took its slot") : null };
  if (a.outcome === "rejected") {
    const failed = a.checks.find((c) => c.verdict === "fail");
    return { label: "Refused", tone: "red", reason: failed ? `${failed.rule}${failed.detail ? `: ${failed.detail}` : ""}` : "the sidecar gave no reason" };
  }
  return null;
}

const when = (ms: number) => new Date(ms).toLocaleTimeString();

function Stage({ name, at, reached, note }: { name: string; at: number | null; reached: boolean | null; note?: string }) {
  return (
    <li className={`stage ${reached === true ? "reached" : reached === null ? "unreported" : ""}`}>
      <span className="stage-name">{name}</span>
      <span className="stage-at">{at ? when(at) : (note ?? "")}</span>
    </li>
  );
}

function Row({ a, d }: { a: Admission; d: Detail | undefined }) {
  const end = ending(a, d);
  const admitted = d?.events.find((e) => e.kind === "admitted");
  const submitted = d?.events.find((e) => e.status === "Submitted");
  const finish = d?.events.find((e) => e.kind === "included" || e.kind === "dropped" || e.kind === "replaced");
  const refused = a.outcome === "rejected";
  const finished = end !== null;
  return (
    <article className="life" data-outcome={a.outcome} data-hash={a.txHash}>
      <div className="life-head">
        <span className="mono" title={a.txHash}>
          {short(a.txHash)}
        </span>
        <span className="sub">
          from <span className="mono">{short(a.sender)}</span>
        </span>
      </div>
      <ol className="stages" aria-label="Lifecycle">
        <Stage name="New" at={admitted?.at ?? (refused ? null : a.at)} reached={!refused} note={refused ? "never admitted" : undefined} />
        {/* In auto mode a transaction can go to the node and land between two status changes, so the sidecar may never report this one. */}
        <Stage name="Submitted" at={submitted?.at ?? null} reached={submitted ? true : refused ? false : finished ? null : false} note={!submitted && !refused && finished ? "not reported" : undefined} />
        <Stage name={end?.label ?? "Waiting"} at={finish?.at ?? (refused ? a.at : null)} reached={finished} />
      </ol>
      {end && <Stamp tone={end.tone} still>{end.label}</Stamp>}
      {a.outcome === "included" && finish?.blockNumber !== undefined && <p className="sub">In block {finish.blockNumber}.</p>}
      {end?.reason && <p className="life-reason">{end.reason}</p>}
    </article>
  );
}

function ReputationTable({ rows, info, account }: { rows: Reputation[]; info: Info | null; account: string | null }) {
  return (
    <div className="scroll">
      <table className="reputation">
        <thead>
          <tr>
            <th>Address</th>
            <th>Status</th>
            <th className="num">Seen</th>
            <th className="num">Included</th>
            <th className="num">Seen before throttling</th>
            <th>Stake</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // The sidecar throttles when floor(seen / denominator) passes included + slack.
            const room = info ? (r.opsIncluded + info.throttlingSlack + 1) * info.minInclusionDenominator - r.opsSeen : null;
            return (
              <tr key={r.address} className={account?.toLowerCase() === r.address.toLowerCase() ? "mine" : ""}>
                <td className="mono">
                  {short(r.address)}
                  {account?.toLowerCase() === r.address.toLowerCase() ? " (this account)" : ""}
                </td>
                <td>
                  <span className={`tag ${r.status === "ok" ? "good" : r.status === "throttled" ? "warn" : "bad"}`}>{r.status}</span>
                </td>
                <td className="num">{r.opsSeen}</td>
                <td className="num">{r.opsIncluded}</td>
                <td className="num">{room === null ? "unknown" : Math.max(room, 0)}</td>
                <td>{r.isStaked ? `${Number(formatEther(BigInt(r.stake)))} ETH` : "none"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function LifecyclePage() {
  const { account, health } = useAccount();
  const [admissions, setAdmissions] = useState<Admission[] | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [reputation, setReputation] = useState<Reputation[] | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [racing, setRacing] = useState(false);
  const [race, setRace] = useState<RaceResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const [page, rep, node] = await Promise.all([
        rpc<{ items: Admission[] }>(DEVNET.mempool, "skandha_explorer_listAdmissions", [{ limit: 100 }]),
        rpc<{ items: Reputation[] }>(DEVNET.mempool, "skandha_explorer_listReputation", [{}]),
        rpc<Info>(DEVNET.mempool, "skandha_explorer_info"),
      ]);
      setAdmissions(page.items);
      setReputation(rep.items);
      setInfo(node);
      setFailed(null);
      const calls: RpcCall[] = page.items.slice(0, SHOWN).map((a) => ({ method: "skandha_explorer_getTransaction", params: [a.txHash] }));
      const answers = await rpcBatch<Detail>(DEVNET.mempool, calls);
      setDetails(Object.fromEntries(answers.map((d, i) => [page.items[i]!.txHash, d])));
    } catch (e) {
      // What was last read stays on screen with this note above it. Nothing is cleared to look like an empty list.
      setFailed((e as Error).message);
    }
  }, []);

  useEffect(() => {
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  async function loseRace() {
    setRacing(true);
    setProblem(null);
    try {
      setRace(await runRace());
      await read();
    } catch (e) {
      setProblem((e as Error).message);
    }
    setRacing(false);
  }

  const mine = (a: Admission) => a.sender.toLowerCase() === account?.toLowerCase();
  const shown = (admissions ?? []).filter((a) => !onlyMine || mine(a)).slice(0, SHOWN);

  return (
    <div className="stack">
      <div className="hero small">
        <h1>What happened to each transaction</h1>
        <p className="lead">
          New, Submitted, then Mined or Cancelled with a reason. All of this is read live from the <Term id="sidecar" />&apos;s own records, through its <code>skandha_explorer</code> methods. Those records are held in memory, so they begin when the mirror booted.
        </p>
      </div>

      {failed && <div className="banner error">The sidecar did not answer: {failed}. {admissions ? "What is below is the last read." : "Nothing is known about its transactions or reputation right now."}</div>}
      {problem && <div className="banner error">{problem}</div>}

      <section className="plain" aria-labelledby="reputation">
        <h2 id="reputation">
          <Term id="reputation">Reputation</Term>
        </h2>
        {reputation === null ? (
          <p className="sub">{failed ? "Unknown." : "Reading…"}</p>
        ) : reputation.length === 0 ? (
          <p className="sub">The sidecar has no entries yet. An address appears once a transaction from it has been admitted.</p>
        ) : (
          <ReputationTable rows={reputation} info={info} account={account} />
        )}
        {info && (
          <p className="sub">
            Sidecar {info.version}, bundling {info.bundlingMode}. An address is throttled when a tenth of what was seen passes what was included by {info.throttlingSlack}, and banned at {info.banSlack}. A refused transaction does not count as seen, so the attacks on the break-in page cost no reputation.
          </p>
        )}
      </section>

      <section className="plain" aria-labelledby="transactions">
        <h2 id="transactions">Transactions</h2>
        <div className="actions life-actions">
          {account && (
            <label className="toggle">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              This account only
            </label>
          )}
          {isLocalStack && health?.demo.available && (
            <button disabled={racing} onClick={loseRace}>
              {racing ? "Racing…" : "Lose a race on purpose"}
            </button>
          )}
        </div>
        {isLocalStack && <p className="sub">The race sends two transactions with one nonce, late in a slot, one to ethrex and one to the sidecar. When ethrex lands first, the sidecar cancels its own and says why. Timing decides it, so it can take a few tries. This is the quickest way to see a real Cancelled.</p>}
        {race && (
          <p className="result break">
            The sidecar&apos;s transaction <span className="mono">{short(race.alt.hash)}</span> ended as {race.alt.status ?? "unknown"}
            {race.alt.reason ? `: ${race.alt.reason}` : ""}. {race.attempts > 1 ? `It took ${race.attempts} races, and the earlier ones are in the list too.` : ""}
          </p>
        )}
        {admissions !== null && shown.length === 0 && <p className="sub">Nothing yet. Run the story on the first page and transactions appear here.</p>}
        <div className="lives">
          {shown.map((a) => (
            <Row key={a.txHash} a={a} d={details[a.txHash]} />
          ))}
        </div>
      </section>
    </div>
  );
}
