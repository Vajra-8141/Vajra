"use client";

import { useState } from "react";
import { type Address, formatEther, isAddress } from "viem";
import { EXPOSURE_TEXT, type Exposure, type ExposureReport, scanAddress } from "@vajra/core";
import { NextStep, PageHead } from "../../components/thread";
import { useReads } from "../../lib/reads";

const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";

const tone: Record<Exposure, string> = { exposed: "bad", delegated: "bad", "no-key-on-chain": "good", contract: "warn", unknown: "" };

export default function ScannerPage() {
  const { status } = useReads();
  const [input, setInput] = useState("");
  const [reports, setReports] = useState<ExposureReport[]>([]);
  const [busy, setBusy] = useState(false);

  const addresses = [...new Set(input.split(/[\s,]+/).filter(Boolean))];
  const valid = addresses.filter((a) => isAddress(a)) as Address[];
  const invalid = addresses.length - valid.length;

  async function scan() {
    setBusy(true);
    setReports([]);
    for (const address of valid) {
      const report = await scanAddress(MAINNET_RPC, address);
      setReports((r) => [...r, report]);
    }
    setBusy(false);
  }

  const counts = reports.reduce<Partial<Record<Exposure, number>>>((c, r) => ({ ...c, [r.verdict]: (c[r.verdict] ?? 0) + 1 }), {});
  const single = reports.length === 1 ? reports[0] : null;

  return (
    <div className="stack">
      <PageHead because="why the master key is made of hashes" title="Is your key already exposed?">
        An address hides its public key until it signs something on chain. After that, a large enough quantum computer can work back to the private key. This checks Ethereum mainnet.
      </PageHead>
      <section className="card">
        <label>
          One address, or many separated by spaces or new lines
          <textarea rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
        {invalid > 0 && <p className="sub">{invalid} entries are not valid addresses and will be skipped.</p>}
        <button className="primary" disabled={busy || status !== "ready" || valid.length === 0} onClick={scan}>
          {busy ? `Checking ${reports.length + 1} of ${valid.length}…` : "Check"}
        </button>
        <p className="sub">Lookups use the route chosen in the menu, because who is checking their exposure is worth hiding too.</p>
      </section>

      {single && (
        <section className="card">
          <h2>{EXPOSURE_TEXT[single.verdict].title}</h2>
          <p>{EXPOSURE_TEXT[single.verdict].detail}</p>
          {single.nonce !== null && (
            <p className="sub">
              {single.nonce.toString()} transactions sent, {Number(formatEther(single.balance!)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH held.
            </p>
          )}
        </section>
      )}

      {reports.length > 1 && (
        <section className="card">
          <h2>
            {reports.length} addresses: {Object.entries(counts).map(([k, v]) => `${v} ${EXPOSURE_TEXT[k as Exposure].title.toLowerCase()}`).join(", ")}
          </h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Verdict</th>
                  <th className="num">Sent</th>
                  <th className="num">ETH</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.address}>
                    <td className="mono">{r.address}</td>
                    <td>
                      <span className={`tag ${tone[r.verdict]}`}>{EXPOSURE_TEXT[r.verdict].title}</span>
                    </td>
                    <td className="num">{r.nonce?.toString() ?? "unknown"}</td>
                    <td className="num">{r.balance === null ? "unknown" : Number(formatEther(r.balance)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <NextStep href="/story" label="Back to the story" why="Your wallet stays. Follow what happens when its key is stolen." />
    </div>
  );
}
