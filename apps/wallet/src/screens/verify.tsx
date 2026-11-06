/**
 * Anyone can check a private payment here, with no wallet. It reads the public node from this browser, so nothing shown is
 * VAJRA's word for it. The sender is searched for too, as a control: it shows the search can find an address that is there.
 */
import { useEffect, useState } from "react";
import { DEVNET } from "@vajra/core/devnet";
import { eth, isAddr, short, useRoute } from "../ui";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Found {
  from: string;
  to: string;
  amount: string;
  block: number;
  raw: string;
}

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(DEVNET.execution, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function read(hash: string): Promise<Found> {
  const [tx, receipt] = (await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])])) as [unknown, { blockNumber: string; logs: { topics: string[]; data: string }[] } | null];
  if (!tx || !receipt) throw new Error("The public node doesn't have that transaction.");
  const move = receipt.logs.find((log) => log.topics[0] === TRANSFER && log.topics.length === 3);
  if (!move) throw new Error("That transaction didn't move any ETH.");
  const address = (topic: string) => `0x${topic.slice(-40)}`;
  return { from: address(move.topics[1]!), to: address(move.topics[2]!), amount: eth(String(Number(BigInt(move.data)) / 1e18)), block: Number(BigInt(receipt.blockNumber)), raw: JSON.stringify({ transaction: tx, receipt }, null, 1) };
}

const count = (raw: string, address: string) => raw.toLowerCase().split(address.toLowerCase().slice(2)).length - 1;

export function Verify() {
  const route = useRoute();
  const query = new URLSearchParams(route.split("?")[1] ?? "");
  const [hash, setHash] = useState(query.get("tx") ?? "");
  const [wallet, setWallet] = useState(query.get("wallet") ?? "");
  const [found, setFound] = useState<Found | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = /^0x[0-9a-fA-F]{64}$/.test(hash.trim());
  const check = () => {
    setBusy(true);
    setBad(null);
    setFound(null);
    read(hash.trim())
      .then(setFound, (e: Error) => setBad(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    if (ok) check();
  }, []);
  const target = wallet.trim();
  const hits = found && isAddr(target) ? count(found.raw, target) : null;
  return (
    <section className="screen">
      <header className="screen-head">
        <h1>Check it yourself</h1>
      </header>
      <p className="lead">Paste a payment and any wallet address. This page reads the public node directly from your browser, then searches the raw data.</p>
      <label className="field">
        <span>Transaction</span>
        <input className="mono-input" autoCapitalize="off" autoComplete="off" spellCheck={false} placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} />
      </label>
      <label className="field">
        <span>Wallet to look for</span>
        <input className="mono-input" autoCapitalize="off" autoComplete="off" spellCheck={false} placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value)} />
      </label>
      <button className="btn primary" disabled={!ok || busy} onClick={check}>
        {busy ? "Reading the chain" : "Search the chain"}
      </button>
      {bad && (
        <p className="danger-text" role="alert">
          {bad}
        </p>
      )}
      {found && (
        <>
          <dl className="facts">
            <dt>Block</dt>
            <dd>{found.block.toLocaleString("en-US")}</dd>
            <dt>Paid by</dt>
            <dd className="mono">{short(found.from)}</dd>
            <dt>Went to</dt>
            <dd className="mono">{short(found.to)}</dd>
            <dt>Amount</dt>
            <dd>{found.amount} ETH</dd>
          </dl>
          {hits !== null && (
            <div className="check-result">
              <p className={hits === 0 ? "safe-on" : "danger-text"}>
                <strong>{short(target)}</strong> appears {hits} {hits === 1 ? "time" : "times"} in this transaction.
              </p>
              <p className="t60 small">
                To show the search works: the sender, {short(found.from)}, appears {count(found.raw, found.from)} times.
              </p>
            </div>
          )}
          <details className="proof">
            <summary>Raw data from {new URL(DEVNET.execution).host}</summary>
            <pre className="raw">{found.raw}</pre>
          </details>
        </>
      )}
    </section>
  );
}
