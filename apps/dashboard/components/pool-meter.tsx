"use client";

/**
 * What the pool hides, read from the chain through the same route as every other read. It needs no key, and it appears only on an account
 * that has a pool: an account with no notes has nothing to say here. A read that failed says unknown, and never reads as an empty pool.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { type PoolFacts, type PoolMeter, isLocalStack, poolMeter, poolWords, readPoolFacts, withTimeout } from "@vajra/core";
import { short } from "../lib/format";

const READ_TIMEOUT_MS = 60_000;
const POLL_PAUSE_MS = isLocalStack ? 4_000 : 30_000;
/** Past this many addresses the rest are one line, so that a large pool does not push the page down. */
const NAMED = 4;

const notes = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;

function Shares({ meter }: { meter: PoolMeter }) {
  const shares = meter.shares!;
  const rest = shares.slice(NAMED);
  const label = `${meter.deposits} notes from ${meter.addresses} ${meter.addresses === 1 ? "address" : "addresses"}, the largest ${shares[0]!.notes}`;
  return (
    <>
      <div className="pool-shares" role="img" aria-label={label}>
        {shares.map((share) => (
          <span key={share.address} className={share.own ? "own" : ""} style={{ flexGrow: share.notes }} />
        ))}
      </div>
      <ul className="pool-legend">
        {shares.slice(0, NAMED).map((share) => (
          <li key={share.address}>
            <span className={`pool-key ${share.own ? "own" : ""}`} />
            {share.own ? "This account" : <span className="mono">{short(share.address)}</span>}, {notes(share.notes)}
          </li>
        ))}
        {rest.length > 0 && <li>{rest.length} more addresses, {notes(rest.reduce((sum, share) => sum + share.notes, 0))}</li>}
      </ul>
    </>
  );
}

export function PoolCard({ account, ready }: { account: Address; ready: boolean }) {
  const [facts, setFacts] = useState<PoolFacts | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const read = await withTimeout(readPoolFacts(account), READ_TIMEOUT_MS, "the pool's read");
        if (!live) return;
        setFacts(read);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
      if (live) timer = setTimeout(poll, POLL_PAUSE_MS);
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [account, ready]);

  if (facts === undefined && !failed) return null;
  if (facts === undefined || (facts === null && failed)) {
    return (
      <section className="card" aria-labelledby="pool">
        <h2 id="pool">What the pool hides</h2>
        <p className="sub">Unknown. The pool could not be read, so nothing is claimed about it right now.</p>
      </section>
    );
  }
  if (facts === null || facts.depositors.length === 0) return null;

  const meter = poolMeter(facts);
  const words = poolWords(meter);
  return (
    <section className="card" aria-labelledby="pool">
      <h2 id="pool">What the pool hides</h2>
      <p className="pool-headline">{words.headline}</p>
      {meter.shares && <Shares meter={meter} />}
      <div className="pool-columns">
        <div>
          <h3>The chain shows</h3>
          <ul>{words.shows.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
        <div>
          <h3>No chain can show</h3>
          <ul>{words.cannotShow.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      </div>
      {words.unknown.map((line) => <p className="sub" key={line}>{line}</p>)}
      {failed && <p className="sub">The latest read failed, so this is the last answer the chain gave.</p>}
    </section>
  );
}
