/**
 * Anyone can check a private payment here, with no wallet. It reads the public node from this browser, so nothing shown is
 * VAJRA's word for it. The sender is searched for too, as a control: it shows the search can find an address that is there.
 */
import { useEffect, useState } from "react";
import { keccak256, toBytes } from "viem";
import { DEVNET } from "@vajra/core/devnet";
import { eth, isAddr, short, useRoute } from "../ui";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SHIELDED = keccak256(toBytes("Shielded(uint256,uint256,uint256)"));
const UNSHIELD = "0xc8c2592d";

interface Payout {
  wallet: string;
  to: string;
  signatures: number;
  verifyGas: number;
  block: number;
  /** Every deposit in this wallet's pool, and how often each appears in the payout. */
  deposits: { commitment: string; hits: number }[];
  nullifier: string;
  raw: string;
}

type Tx = { sender: string; signatures?: unknown[]; frames?: { data: string }[] };
type Receipt = { blockNumber: string; frameReceipts?: { gasUsed: string }[]; logs: { topics: string[]; data: string }[] };

async function readPayout(tx: Tx, receipt: Receipt): Promise<Payout> {
  const words = tx.frames![1]!.data.slice(10).match(/.{64}/g)!;
  const logs = (await rpc("eth_getLogs", [{ address: tx.sender, topics: [SHIELDED], fromBlock: "0x0", toBlock: "latest" }])) as { topics: string[] }[];
  const raw = JSON.stringify({ transaction: tx, receipt }, null, 1);
  return {
    wallet: tx.sender,
    to: `0x${words[2]!.slice(-40)}`,
    signatures: tx.signatures?.length ?? 0,
    verifyGas: Number(BigInt(receipt.frameReceipts![0]!.gasUsed)),
    block: Number(BigInt(receipt.blockNumber)),
    deposits: logs.map((log) => ({ commitment: log.topics[1]!, hits: raw.toLowerCase().split(log.topics[1]!.slice(2).toLowerCase()).length - 1 })),
    nullifier: `0x${words[1]!}`,
    raw,
  };
}

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

async function read(hash: string): Promise<Found | Payout> {
  const [tx, receipt] = (await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])])) as [Tx | null, Receipt | null];
  if (!tx || !receipt) throw new Error("The public node doesn't have that transaction.");
  if (tx.frames?.[1]?.data.startsWith(UNSHIELD)) return readPayout(tx, receipt);
  const move = receipt.logs.find((log) => log.topics[0] === TRANSFER && log.topics.length === 3);
  if (!move) throw new Error("This page only reads private payments and plain sends, and this is another kind of transaction.");
  const address = (topic: string) => `0x${topic.slice(-40)}`;
  return { from: address(move.topics[1]!), to: address(move.topics[2]!), amount: eth(String(Number(BigInt(move.data)) / 1e18)), block: Number(BigInt(receipt.blockNumber)), raw: JSON.stringify({ transaction: tx, receipt }, null, 1) };
}

const isPayout = (x: Found | Payout): x is Payout => "deposits" in x;

function PayoutCheck({ p }: { p: Payout }) {
  const named = p.deposits.filter((d) => d.hits > 0).length;
  return (
    <>
      <dl className="facts">
        <dt>Block</dt>
        <dd>{p.block.toLocaleString("en-US")}</dd>
        <dt>Paid by</dt>
        <dd className="mono">{short(p.wallet)}</dd>
        <dt>Paid to</dt>
        <dd className="mono">{short(p.to)}</dd>
        <dt>Key signatures</dt>
        <dd>{p.signatures}</dd>
        <dt>Gas to check the proof</dt>
        <dd>{p.verifyGas.toLocaleString("en-US")}</dd>
      </dl>
      <div className="check-result">
        <p className={named === 0 ? "safe-on" : "danger-text"}>
          <strong>
            {named} of {p.deposits.length} {p.deposits.length === 1 ? "deposit is" : "deposits are"}
          </strong>{" "}
          named in this payout.
        </p>
        <ul className="plain small">
          {p.deposits.map((d, i) => (
            <li key={d.commitment} className="mono">
              Note {i + 1}: {short(d.commitment)} appears {d.hits} times
            </li>
          ))}
        </ul>
        <p className="t60 small">The chain accepted a proof that one of these notes paid, without being told which. That hides more as the pool holds more notes.</p>
        {p.deposits.length < 2 && <p className="note-warn">This pool has only one note, so anyone can guess which one paid.</p>}
        <p className="t60 small">What stays public: this wallet made the payment, and who received it.</p>
      </div>
      <details className="proof">
        <summary>Raw data from {new URL(DEVNET.execution).host}</summary>
        <pre className="raw">{p.raw}</pre>
      </details>
    </>
  );
}

const count = (raw: string, address: string) => raw.toLowerCase().split(address.toLowerCase().slice(2)).length - 1;

export function Verify() {
  const route = useRoute();
  const query = new URLSearchParams(route.split("?")[1] ?? "");
  const [hash, setHash] = useState(query.get("tx") ?? "");
  const [wallet, setWallet] = useState(query.get("wallet") ?? "");
  const [result, setFound] = useState<Found | Payout | null>(null);
  const found = result && !isPayout(result) ? result : null;
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
        <span>Wallet to look for (private payments only)</span>
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
      {result && isPayout(result) && <PayoutCheck p={result} />}
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
