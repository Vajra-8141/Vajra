"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, formatEther, isAddress, parseEther } from "viem";
import {
  DEVNET,
  ETH,
  ROTATION_LEAF,
  accountAbi,
  accountState,
  dailyTx,
  framesSucceeded,
  ops,
  publicClient,
  queuedEvents,
  refusalName,
  submit,
  walletMessage,
  withWalletSignature,
} from "@vajra/core";
import { type BridgeStatus, bridgeStatus, createOnBridge, master } from "../lib/bridge";
import { NETWORKS, useReads } from "../lib/reads";
import { connectWallet, hasWallet, personalSign } from "../lib/wallet";

interface Item {
  id: bigint;
  recipient: Address;
  amount: bigint;
  executeAfter: bigint;
  state: number;
}

interface Chain {
  dailyKey: Address;
  frozen: boolean;
  balance: bigint;
  limit: bigint;
  allowance: bigint;
  spent: bigint;
  items: Item[];
}

const REFUSALS: Record<string, string> = {
  AccountFrozen: "The account is frozen. Only the master key can unfreeze it.",
  EscapeKeyOutranks: "That needs the master key. The daily key cannot do it.",
  HarborImmutable: "Only the master key can change the harbor.",
  NotDailyKey: "This wallet is not the account's daily key.",
  ChainStateUnknown: "The chain's key tree does not match this signer, so it will not sign.",
  TreeExhausted: "No one-time keys left. Rotate to a new tree.",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
const explain = (error: unknown) => {
  const name = refusalName((error as Error).message);
  return REFUSALS[name] ? `${name}: ${REFUSALS[name]}` : name;
};

function countdown(seconds: number) {
  if (seconds <= 0) return "matured";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}

async function readChain(account: Address): Promise<Chain> {
  const [state, balance, rule] = await Promise.all([
    accountState(account),
    publicClient.getBalance({ address: account }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "rule", args: [ETH] }) as Promise<readonly [boolean, bigint, bigint, bigint]>,
  ]);
  const ids = Array.from({ length: Number(state.nextItem) }, (_, i) => BigInt(i)).slice(-12);
  const items = await Promise.all(
    ids.map(async (id) => ({ id, ...((await publicClient.readContract({ address: account, abi: accountAbi, functionName: "queuedItem", args: [id] })) as Omit<Item, "id">) })),
  );
  return { dailyKey: state.dailyKey, frozen: state.frozen, balance, limit: rule[1], allowance: rule[2], spent: rule[3], items };
}

function CreateAccount({ daily, onCreated }: { daily: Address | null; onCreated: () => void }) {
  const [form, setForm] = useState({ harbor: "", dailyLimit: "0.001", coolingAllowance: "0.0002", queueDelay: "120", coolingPeriod: "60", fund: "0.015" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await createOnBridge({ ...form, dailyKey: daily!, queueDelay: Number(form.queueDelay), coolingPeriod: Number(form.coolingPeriod) });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <section className="card" aria-labelledby="create">
      <h2 id="create">Create your account</h2>
      <p className="sub">Your wallet becomes the daily key. The master key is generated on this machine and never reaches this page.</p>
      {error && <div className="banner error">{error}</div>}
      <label>
        Harbor: the one address an escape can send funds to
        <input value={form.harbor} onChange={set("harbor")} placeholder="0x…" spellCheck={false} />
      </label>
      <div className="row">
        <label>
          Daily limit, ETH
          <input value={form.dailyLimit} onChange={set("dailyLimit")} />
        </label>
        <label>
          New-payee allowance, ETH
          <input value={form.coolingAllowance} onChange={set("coolingAllowance")} />
        </label>
        <label>
          Queue delay, seconds
          <input value={form.queueDelay} onChange={set("queueDelay")} />
        </label>
        <label>
          New-payee cooling, seconds
          <input value={form.coolingPeriod} onChange={set("coolingPeriod")} />
        </label>
        <label>
          Fund with, ETH
          <input value={form.fund} onChange={set("fund")} />
        </label>
      </div>
      <button className="primary" disabled={busy || !daily || !isAddress(form.harbor)} onClick={create}>
        {busy ? "Creating…" : daily ? "Create account" : "Connect a wallet first"}
      </button>
    </section>
  );
}

export default function AccountPage() {
  const { status, network } = useReads();
  const [bridge, setBridge] = useState<BridgeStatus | null | "down">(null);
  const [wallet, setWallet] = useState<Address | null>(null);
  const [chain, setChain] = useState<Chain | "unknown" | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  const say = useCallback((line: string) => setLog((l) => [...l.slice(-40), line]), []);
  const account = bridge && bridge !== "down" ? bridge.account : null;

  const refreshBridge = useCallback(() => bridgeStatus().then(setBridge, () => setBridge("down")), []);
  const refreshChain = useCallback(async () => {
    if (!account) return;
    await readChain(account).then(setChain, () => setChain("unknown"));
  }, [account]);

  useEffect(() => {
    refreshBridge();
  }, [refreshBridge]);

  useEffect(() => {
    if (status !== "ready" || !account) return;
    refreshChain();
    const timer = setInterval(refreshChain, 8000);
    return () => clearInterval(timer);
  }, [status, account, refreshChain]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [log]);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setProblem(null);
    setNotice(null);
    try {
      await work();
      await Promise.all([refreshBridge(), refreshChain()]);
    } catch (e) {
      setProblem(explain(e));
      say(`refused: ${refusalName((e as Error).message)}`);
    }
    setBusy(null);
    setArmed(false);
  }

  const asMaster = (label: string, request: Record<string, string>) =>
    run(label, async () => {
      say(`master: ${label}`);
      const r = await master(request);
      say(`mined ${short(r.hash)} in block ${r.block}, VERIFY ${r.verifyGas.toLocaleString()} gas, leaf ${r.leaf}`);
      setNotice(`${label} is on chain.`);
    });

  const spend = () =>
    run("spend", async () => {
      const nonce = BigInt(await publicClient.getTransactionCount({ address: account! }));
      const unsigned = dailyTx({ account: account!, dailyKey: wallet!, nonce, calls: [ops.spend(ETH, to as Address, parseEther(amount))] });
      say("asking your wallet to sign");
      const signature = await personalSign(walletMessage(unsigned), wallet!);
      const { hash, receipt } = await submit(withWalletSignature(unsigned, signature), { log: say });
      if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but the spend failed`);
      const [queued] = queuedEvents(receipt.frameReceipts[1]!.logs as { topics: `0x${string}`[]; data: `0x${string}` }[]);
      say(`mined ${short(hash)} in block ${Number(receipt.blockNumber)}`);
      setNotice(
        queued
          ? `Over the rules, so it was queued as item ${queued.id}. It runs after the delay unless the master key vetoes it.`
          : "Sent.",
      );
      setAmount("");
    });

  const execute = (id: bigint) =>
    run("execute", async () => {
      const nonce = BigInt(await publicClient.getTransactionCount({ address: account! }));
      const unsigned = dailyTx({ account: account!, dailyKey: wallet!, nonce, calls: [ops.executeQueued(id)] });
      const signature = await personalSign(walletMessage(unsigned), wallet!);
      const { hash, receipt } = await submit(withWalletSignature(unsigned, signature), { log: say });
      if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but the item did not run`);
      say(`mined ${short(hash)} in block ${Number(receipt.blockNumber)}`);
      setNotice(`Item ${id} ran.`);
    });

  if (bridge === null) return <p className="sub">Looking for the master key bridge…</p>;
  if (bridge === "down")
    return (
      <section className="card">
        <h1 className="page-title">The master key bridge is not running</h1>
        <p className="sub">
          It holds the master key so this page never has to. Start it with <code>node packages/cli/src/main.ts bridge</code>, then reload.
        </p>
      </section>
    );

  const connect = (
    <button onClick={() => connectWallet().then(setWallet, (e: Error) => setProblem(e.message))} disabled={!hasWallet()}>
      {wallet ? short(wallet) : hasWallet() ? "Connect wallet" : "No wallet in this browser"}
    </button>
  );

  if (!account)
    return (
      <div className="stack">
        <h1 className="page-title">A bank account for Ethereum, with a key made of hashes.</h1>
        <div>{connect}</div>
        {problem && <div className="banner error">{problem}</div>}
        <CreateAccount daily={wallet} onCreated={refreshBridge} />
      </div>
    );

  const known = chain && chain !== "unknown" ? chain : null;
  const pending = known?.items.filter((i) => i.state === 1) ?? [];
  const usedShare = known && known.limit > 0n ? Number((known.spent * 100n) / known.limit) : 0;
  const isDailyKey = wallet && known && wallet.toLowerCase() === known.dailyKey.toLowerCase();
  const leaves = bridge.leavesLeft;

  return (
    <>
      {bridge.rootMatches === false && <div className="banner error">ChainStateUnknown: the account's key tree is not this signer's. Nothing will be signed.</div>}
      {known?.frozen && <div className="banner frozen">Frozen. Every daily-key transaction is refused until the master key unfreezes the account.</div>}
      {problem && <div className="banner error">{problem}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="grid">
        <div className="stack">
          <section className="card" aria-labelledby="balance">
            <h2 id="balance">Balance</h2>
            <div className="big">{known ? eth(known.balance) : chain === "unknown" ? "Unknown" : "…"}</div>
            <div className="sub mono break">{account}</div>
            {known && (
              <>
                <div className={`meter ${usedShare >= 100 ? "full" : ""}`} role="img" aria-label={`${usedShare}% of the daily limit used`}>
                  <span style={{ width: `${Math.min(usedShare, 100)}%` }} />
                </div>
                <div className="sub">
                  {eth(known.spent)} of {eth(known.limit)} used in the last 24 hours. New payees are capped at {eth(known.allowance)} until they cool.
                </div>
              </>
            )}
            {chain === "unknown" && <div className="sub">The read failed, so nothing is claimed about this account right now.</div>}
          </section>

          <section className="card" aria-labelledby="spend">
            <h2 id="spend">Spend with the daily key</h2>
            <div style={{ marginBottom: 10 }}>{connect}</div>
            {wallet && known && !isDailyKey && <div className="banner warn">This wallet is not the daily key, {short(known.dailyKey)}.</div>}
            <label>
              To
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} />
            </label>
            <label>
              Amount, ETH
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0001" inputMode="decimal" />
            </label>
            <button className="primary" disabled={!!busy || !isDailyKey || !isAddress(to) || !amount} onClick={spend}>
              {busy === "spend" ? "Sending…" : "Sign and send"}
            </button>
            <p className="sub">Anything over the rules is not refused. It joins the public queue below, where it waits and can be cancelled.</p>
          </section>

          <section className="card" aria-labelledby="queue">
            <h2 id="queue">Public queue</h2>
            {pending.length === 0 && <p className="sub">Nothing is waiting.</p>}
            {pending.map((item) => {
              const left = Number(item.executeAfter) - now;
              return (
                <div className="item" key={item.id.toString()}>
                  <div>
                    <div>
                      {eth(item.amount)} to <span className="mono">{short(item.recipient)}</span>
                    </div>
                    <div className="sub">Item {item.id.toString()}, {left > 0 ? `executes in ${countdown(left)}` : "matured"}</div>
                  </div>
                  <div className="actions">
                    {left <= 0 && (
                      <button disabled={!!busy || !isDailyKey || known?.frozen} onClick={() => execute(item.id)}>
                        Execute
                      </button>
                    )}
                    <button className="danger" disabled={!!busy} onClick={() => asMaster(`Veto of item ${item.id}`, { op: "veto", id: item.id.toString() })}>
                      Veto
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        </div>

        <div className="stack">
          <section className="card master" aria-labelledby="master">
            <h2 id="master">Master key</h2>
            <div className="big">{leaves}</div>
            <div className="sub">
              one-time keys left of {ROTATION_LEAF}, plus one reserved for rotation. Held by a software signer on this machine.
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              {known?.frozen ? (
                <button disabled={!!busy} onClick={() => asMaster("Unfreeze", { op: "unfreeze" })}>
                  Unfreeze
                </button>
              ) : (
                <button disabled={!!busy || !known} onClick={() => asMaster("Freeze", { op: "freeze" })}>
                  Freeze
                </button>
              )}
              <button disabled={!!busy} onClick={() => asMaster("Rotation", { op: "rotate" })}>
                Rotate keys
              </button>
            </div>
          </section>

          <section className="card danger" aria-labelledby="escape">
            <h2 id="escape">Escape</h2>
            <p className="sub" style={{ marginTop: 0 }}>
              Sends everything to your sealed harbor and freezes the account. A stolen daily key cannot stop this, redirect it, or block it from reaching the alt mempool.
            </p>
            {bridge.harbor && (
              <p className="sub">
                Harbor <span className="mono">{short(bridge.harbor)}</span>. The chain holds only a hash of it until now.
              </p>
            )}
            {armed ? (
              <div className="actions">
                <button className="danger armed" disabled={!!busy} onClick={() => asMaster("Escape", { op: "escape" })}>
                  Confirm escape
                </button>
                <button onClick={() => setArmed(false)}>Cancel</button>
              </div>
            ) : (
              <button className="danger" disabled={!!busy} onClick={() => setArmed(true)}>
                Escape to harbor
              </button>
            )}
          </section>

          <section className="card" aria-labelledby="activity">
            <h2 id="activity">This session</h2>
            <div className="log">
              {log.length === 0 ? "Nothing yet." : log.map((line, i) => <div key={i}>{line}</div>)}
              <div ref={bottom} />
            </div>
          </section>
        </div>
      </div>

      <p className="note">
        What is private here: {NETWORKS[network].private ? "your reads, and " : ""}your harbor until you escape. What is not: balances, rules and the queue are public on chain, and master-key operations leave from this machine directly. Hidden balances are not built. Devnet only, chain {DEVNET.chainId}.
      </p>
    </>
  );
}
