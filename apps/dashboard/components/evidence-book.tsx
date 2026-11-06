import type { ComponentType } from "react";
import { type EvidenceRecord, ORIGINS, type Origin } from "../lib/evidence";

const ORDER: Origin[] = ["public", "public-before-reset", "mirror", "unknown"];
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const utc = (at: string | null) => (at ? new Date(at).toUTCString() : "time not recorded");
const trimmed = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

function Record({ record, Live }: { record: EvidenceRecord; Live?: ComponentType<{ hash: string; origin: Origin }> }) {
  return (
    <article className="record" data-file={record.file} data-origin={record.origin}>
      <h3>{record.title}</h3>
      <p>{record.what}</p>
      <p className="sub">
        {utc(record.at)}, chain {record.chainId ?? "not recorded"}.{record.command ? " Reproduce with " : ""}
        {record.command && <code>{record.command}</code>}
        {record.command ? "." : ""} <a href={`/evidence/${record.file}`}>Raw record</a>
      </p>
      {record.facts.length > 0 && (
        <dl className="facts">
          {record.facts.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd className="break">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {record.transactions.length > 0 && (
        <details>
          <summary>{record.transactions.length} transactions</summary>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Transaction</th>
                  <th className="num">VERIFY gas</th>
                  {Live && <th>Now</th>}
                </tr>
              </thead>
              <tbody>
                {record.transactions.map((t, i) => (
                  <tr key={`${i}${t.hash}`}>
                    <td>{t.step}</td>
                    <td className="mono">{shortHash(t.hash)}</td>
                    <td className="num">{t.verifyGas === null ? "not recorded" : t.verifyGas.toLocaleString("en-US")}</td>
                    {Live && (
                      <td>
                        <Live hash={t.hash} origin={record.origin} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {record.refusals.length > 0 && (
        <details>
          <summary>{record.refusals.length} attacks refused</summary>
          <div className="scroll">
            <table>
              <tbody>
                {record.refusals.map((r) => (
                  <tr key={r.attack}>
                    <td>{r.attack}</td>
                    <td className="mono">{trimmed(r.refusal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </article>
  );
}

/** Every recorded run, grouped by where it really happened. Shared by the dashboard and the static export, so their labels cannot drift. */
export function EvidenceBook({ records, Live }: { records: EvidenceRecord[]; Live?: ComponentType<{ hash: string; origin: Origin }> }) {
  return (
    <>
      <section className="plain" aria-labelledby="escape-proof">
        <h2 id="escape-proof">The exit a thief cannot block</h2>
        <p>
          A thief holding the daily key keeps a transaction pending. The canonical mempool then refuses the same signed escape: <code>A frame transaction in the other nonce-key domain is already pending for this sender</code>. The alt mempool admits it and it mines.
        </p>
        <p className="sub">It holds for as long as the thief&apos;s transaction stays pending, which on an idle devnet means sending one every slot. Reproduce with <code>vajra pin</code>.</p>
      </section>

      <section className="plain" aria-labelledby="gas">
        <h2 id="gas">Measured validation gas</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Master key</th>
                <th className="num">Signature</th>
                <th className="num">VERIFY gas, median</th>
                <th>Public alt mempool, when measured</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>WOTS, w=16</td>
                <td className="num">2,144 B</td>
                <td className="num">90,009</td>
                <td>
                  <span className="tag good">admitted and mined</span>
                </td>
              </tr>
              <tr>
                <td>WOTS, w=256</td>
                <td className="num">1,120 B</td>
                <td className="num">334,362</td>
                <td>
                  <span className="tag bad">refused, over the 100,000 cap</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="sub">Measured while the public alt mempool still capped validation at 100,000. It no longer does, and w=256 has not been rerun there since. The canonical path still refuses anything over 100,000.</p>
      </section>

      {ORDER.map((origin) => {
        const group = records.filter((r) => r.origin === origin);
        if (group.length === 0) return null;
        return (
          <section className="plain" key={origin} data-origin-group={origin} aria-label={ORIGINS[origin].heading}>
            <h2>{ORIGINS[origin].heading}</h2>
            <p className="origin-note">{ORIGINS[origin].text}</p>
            {group.map((record) => (
              <Record key={record.file} record={record} Live={Live} />
            ))}
          </section>
        );
      })}

      <section className="plain" aria-labelledby="not-proved">
        <h2 id="not-proved">What this does not prove</h2>
        <ul>
          <li>This is not production post-quantum cryptography. The parameters are unreviewed and there is no formal proof.</li>
          <li>Stealth spending is not safe against a sender who also owns a quantum computer.</li>
          <li>Unless a record says otherwise, the master key is a software signer. Hidden balances and STARK recovery are designed, not built.</li>
          <li>Devnet only. It can reset at any time, and the explorer keeps its history in memory.</li>
        </ul>
      </section>
    </>
  );
}
