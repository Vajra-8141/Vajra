"use client";

import { useEffect, useState } from "react";
import { DEVNET, receiptOf } from "@vajra/core";
import { useReads } from "../../lib/reads";

interface Evidence {
  at: string;
  account: string;
  transactions: { step: string; hash: `0x${string}`; block: number; verifyGas: number; totalGas: number }[];
  refusals: { attack: string; refusal: string }[];
}

interface Stealth {
  at: string;
  account: string;
  spendTx: `0x${string}`;
  block: number;
  frameGas: number[];
}

const load = <T,>(name: string): Promise<T | null> =>
  fetch(`/evidence/${name}`).then(
    (r) => (r.ok ? (r.json() as Promise<T>) : null),
    () => null,
  );

const txLink = (hash: string) => `${DEVNET.explorer}/tx/${hash}`;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export default function ProofPage() {
  const { status } = useReads();
  const [e2e, setE2e] = useState<Evidence | null>(null);
  const [stealth, setStealth] = useState<Stealth | null>(null);
  const [live, setLive] = useState<Record<string, "mined" | "gone" | "unknown">>({});

  useEffect(() => {
    load<Evidence>("e2e-latest.json").then(setE2e);
    load<Stealth>("stealth-latest.json").then(setStealth);
  }, []);

  useEffect(() => {
    if (status !== "ready") return;
    const hashes = [...(e2e?.transactions.map((t) => t.hash) ?? []), ...(stealth ? [stealth.spendTx] : [])];
    for (const hash of hashes) {
      receiptOf(hash).then(
        (receipt) => setLive((l) => ({ ...l, [hash]: receipt ? "mined" : "gone" })),
        () => setLive((l) => ({ ...l, [hash]: "unknown" })),
      );
    }
  }, [status, e2e, stealth]);

  const Live = ({ hash }: { hash: string }) => {
    const state = live[hash];
    if (state === "mined") return <span className="tag good">on chain now</span>;
    if (state === "gone") return <span className="tag warn">not found, devnet may have reset</span>;
    return <span className="tag">{state === "unknown" ? "unknown" : "checking"}</span>;
  };

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">What the chain actually did</h1>
        <p className="lead">
          Every line here is from a run against the live devnet, chain {DEVNET.chainId}. Reproduce any of it with the commands in the repository.
        </p>
      </div>

      <section className="card">
        <h2>The exit a thief cannot block</h2>
        <p style={{ marginTop: 0 }}>
          A thief holding the daily key keeps a transaction pending. The canonical mempool then refuses the same signed escape: <code>A frame transaction in the other nonce-key domain is already pending for this sender</code>. The alt mempool admits it and it mines.
        </p>
        <p className="sub">
          It holds for as long as the thief's transaction stays pending, which on this idle devnet means sending one every slot. Reproduce with <code>vajra pin</code>.
        </p>
      </section>

      <section className="card">
        <h2>Measured validation gas</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Master key</th>
                <th className="num">Signature</th>
                <th className="num">VERIFY gas, median</th>
                <th>Live alt mempool</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>WOTS, w=16</td>
                <td className="num">2,144 B</td>
                <td className="num">89,960</td>
                <td>
                  <span className="tag good">admitted and mined</span>
                </td>
              </tr>
              <tr>
                <td>WOTS, w=256</td>
                <td className="num">1,120 B</td>
                <td className="num">319,781</td>
                <td>
                  <span className="tag bad">refused, over the 100,000 cap</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="sub">ERC-8421 allows a staked entity 1,000,000, but the deployed sidecar does not implement that yet, so w=256 is refused even with a stake.</p>
      </section>

      {stealth && (
        <section className="card">
          <h2>A stealth spend with no ETH anywhere</h2>
          <p style={{ marginTop: 0 }}>
            Received through an ML-KEM-768 announcement, spent with a hash signature and a co-signature, gas paid by a paymaster. The sender, who holds the whole hash key, tried to take the money back and was refused with <code>CoSignerRequired</code>.
          </p>
          <div className="item">
            <a className="mono" href={txLink(stealth.spendTx)} target="_blank" rel="noreferrer">
              {short(stealth.spendTx)}
            </a>
            <Live hash={stealth.spendTx} />
          </div>
          <p className="sub">Frame gas: {stealth.frameGas.map((g) => g.toLocaleString()).join(" / ")}. Validate, pay, transfer.</p>
        </section>
      )}

      {e2e && (
        <>
          <section className="card">
            <h2>Transactions, {new Date(e2e.at).toUTCString()}</h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Transaction</th>
                    <th className="num">VERIFY gas</th>
                    <th>Now</th>
                  </tr>
                </thead>
                <tbody>
                  {e2e.transactions.map((t) => (
                    <tr key={t.hash}>
                      <td>{t.step}</td>
                      <td>
                        <a className="mono" href={txLink(t.hash)} target="_blank" rel="noreferrer">
                          {short(t.hash)}
                        </a>
                      </td>
                      <td className="num">{t.verifyGas.toLocaleString()}</td>
                      <td>
                        <Live hash={t.hash} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h2>{e2e.refusals.length} attacks, each refused at the door</h2>
            <div className="scroll">
              <table>
                <tbody>
                  {e2e.refusals.map((r) => (
                    <tr key={r.attack}>
                      <td>{r.attack}</td>
                      <td className="mono">{r.refusal.length > 44 ? `${r.refusal.slice(0, 44)}…` : r.refusal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="card">
        <h2>What this does not prove</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>This is not production post-quantum cryptography. The parameters are unreviewed and there is no formal proof.</li>
          <li>Stealth spending is not safe against a sender who also owns a quantum computer.</li>
          <li>The master key here is a software signer. Hidden balances and STARK recovery are designed, not built.</li>
          <li>Devnet only. It can reset at any time, and the explorer keeps its history in memory.</li>
        </ul>
      </section>
    </div>
  );
}
