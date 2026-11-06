"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, formatEther, isAddress, parseEther } from "viem";
import {
  type AccountView,
  DEVNET,
  ETH,
  ROTATION_LEAF,
  dailyTx,
  framesSucceeded,
  ops,
  publicClient,
  queuedEvents,
  readAccount,
  refusalName,
  submit,
  walletMessage,
  withTimeout,
  withWalletSignature,
} from "@vajra/core";
import { OneTimeKeys } from "../components/leaves";
import { type BridgeStatus, bridgeStatus, createOnBridge, master } from "../lib/bridge";
import { NETWORKS, useReads } from "../lib/reads";
import { connectWallet, hasWallet, personalSign } from "../lib/wallet";

const REFUSALS: Record<string, string> = {
  AccountFrozen: "The account is frozen. Only the master key can unfreeze it.",
  EscapeKeyOutranks: "That needs the master key. The daily key cannot do it.",
  HarborImmutable: "Only the master key can change the harbor.",
  NotDailyKey: "This wallet is not the account's daily key.",
  ChainStateUnknown: "The chain's key tree does not match this signer, so it will not sign.",
  TreeExhausted: "No one-time keys left. Rotate to a new tree.",
};

/** A mixnet round trip can take many seconds. Past this, a read has failed and the page should say so. */
const READ_TIMEOUT_MS = 60_000;
const POLL_PAUSE_MS = 8_000;
/** How long `submit` keeps watching for a receipt, which over a mixnet is several slow round trips per check. */
const SUBMIT_TIMEOUT_MS = 420_000;

const SIGNER_TEXT: Record<BridgeStatus["signer"], string> = {
  software: "Held by a software signer on this machine, which malware here could reach.",
  esp32: "Held on your USB signer. Read each operation on its screen and press BOOT to approve. While it is plugged in, malware on this machine could copy it, so unplug it when you are done.",
  emulator: "Held by a device emulator: a test harness, not hardware.",
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

/** Three short tones. A browser only plays sound after a click on the page, and connecting the wallet is that click. */
function beep() {
  try {
    const audio = new AudioContext();
    for (let i = 0; i < 3; i++) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = 880;
      gain.gain.value = 0.2;
      tone.connect(gain).connect(audio.destination);
      tone.start(audio.currentTime + i * 0.3);
      tone.stop(audio.currentTime + i * 0.3 + 0.18);
    }
  } catch {
    // No sound is not a failure: the red banner still shows.
  }
}

/** Fires on what the chain says is queued, and nothing else. The queue is public, so a theft has to show up here. */
function Alarm({ items, now, busy, onVeto, onPay }: { items: AccountView["items"]; now: number; busy: boolean; onVeto: (id: bigint) => void; onPay: (id: bigint) => void }) {
  const heard = useRef(new Set<bigint>());
  const [dismissed, setDismissed] = useState<Set<bigint>>(new Set());
  useEffect(() => {
    if (items.some((item) => !heard.current.has(item.id))) beep();
    for (const item of items) heard.current.add(item.id);
  }, [items]);
  const live = items.filter((item) => !dismissed.has(item.id));
  if (live.length === 0) return null;
  return (
    <div className="alarm" role="alert">
      {live.map((item) => {
        const left = Number(item.executeAfter) - now;
        return (
          <div key={item.id.toString()}>
            <strong>
              {eth(item.amount)} to <span className="mono">{short(item.recipient)}</span>
            </strong>
            <div>{left > 0 ? `Leaves in ${countdown(left)} unless you stop it. Was this you?` : "Matured. Anyone can execute it now."}</div>
            <div className="actions">
              <button className="danger" disabled={busy} onClick={() => onVeto(item.id)}>
                Not me, cancel
              </button>
              <button disabled={busy} onClick={() => onPay(item.id)}>
                Pay, it's me
              </button>
              <button disabled={busy} onClick={() => setDismissed((d) => new Set(d).add(item.id))}>
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** What actually signed. The same account, two kinds of signature, and the hash one outranks the other. */
function SignedBy({ daily, master }: { daily: { gas: number; hash: string } | null; master: { gas: number; hash: string } | null }) {
  return (
    <section className="card" aria-labelledby="signed">
      <h2 id="signed">Who signed</h2>
      <div className="signed">
        <div>
          <span className="tag warn">Daily key</span>
          <div>secp256k1, 65 bytes. A quantum computer can break this.</div>
          <div className="sub">{daily ? `${daily.gas.toLocaleString()} gas to verify, ${short(daily.hash)}` : "Nothing signed yet"}</div>
        </div>
        <div>
          <span className="tag good">Master key</span>
          <div>Winternitz hash key, 2,144 bytes. No curve to break.</div>
          <div className="sub">{master ? `${master.gas.toLocaleString()} gas to verify, ${short(master.hash)}` : "Nothing signed yet"}</div>
        </div>
      </div>
    </section>
  );
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
  const [chain, setChain] = useState<AccountView | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const reading = useRef(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [operations, setOperations] = useState(0);
  const [lastDaily, setLastDaily] = useState<{ gas: number; hash: string } | null>(null);
  const [lastMaster, setLastMaster] = useState<{ gas: number; hash: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const say = useCallback((line: string) => setLog((l) => [...l.slice(-40), line]), []);
  const account = bridge && bridge !== "down" ? bridge.account : null;

  const refreshBridge = useCallback(() => bridgeStatus().then(setBridge, () => setBridge("down")), []);
  // One read at a time. On a slow route, starting another before the last has finished only lengthens the queue.
  const refreshChain = useCallback(async () => {
    if (!account || reading.current) return;
    reading.current = true;
    try {
      setChain(await withTimeout(readAccount(account), READ_TIMEOUT_MS, "the read"));
      setReadAt(Date.now());
      setReadFailed(false);
    } catch {
      setReadFailed(true);
    }
    reading.current = false;
  }, [account]);

  useEffect(() => {
    refreshBridge();
  }, [refreshBridge]);

  useEffect(() => {
    if (status !== "ready" || !account) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshChain();
      if (live) timer = setTimeout(poll, POLL_PAUSE_MS);
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
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
      refreshBridge();
      refreshChain();
    } catch (e) {
      setProblem(explain(e));
      say(`refused: ${refusalName((e as Error).message)}`);
    }
    setBusy(null);
    setArmed(false);
  }

  const asMaster = (label: string, request: Record<string, string>) =>
    run(label, async () => {
      say(bridge !== "down" && bridge?.signer === "esp32" ? `${label}: check the signer's screen and press BOOT` : `master: ${label}`);
      const r = await master(request);
      say(`mined ${short(r.hash)} in block ${r.block}, VERIFY ${r.verifyGas.toLocaleString()} gas, leaf ${r.leaf}`);
      setLastMaster({ gas: r.verifyGas, hash: r.hash });
      setNotice(`${label} is on chain.`);
      // In this order. Read first, and the page sees the key it just used as spent by someone else, and raises a false alarm.
      await refreshBridge();
      setOperations((n) => n + 1);
    });

  const spend = () =>
    run("spend", async () => {
      const nonce = BigInt(await publicClient.getTransactionCount({ address: account! }));
      const unsigned = dailyTx({ account: account!, dailyKey: wallet!, nonce, calls: [ops.spend(ETH, to as Address, parseEther(amount))] });
      say("asking your wallet to sign");
      const signature = await personalSign(walletMessage(unsigned), wallet!);
      const { hash, receipt } = await submit(withWalletSignature(unsigned, signature), { log: say, timeoutMs: SUBMIT_TIMEOUT_MS });
      if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but the spend failed`);
      const [queued] = queuedEvents(receipt.frameReceipts[1]!.logs as { topics: `0x${string}`[]; data: `0x${string}` }[]);
      say(`mined ${short(hash)} in block ${Number(receipt.blockNumber)}`);
      setLastDaily({ gas: Number(BigInt(receipt.frameReceipts[0]!.gasUsed)), hash });
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
      const { hash, receipt } = await submit(withWalletSignature(unsigned, signature), { log: say, timeoutMs: SUBMIT_TIMEOUT_MS });
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

  const known = chain;
  const age = readAt ? Math.max(0, now - Math.floor(readAt / 1000)) : null;
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
      <Alarm
        items={pending}
        now={now}
        busy={!!busy}
        onVeto={(id) => asMaster(`Veto of item ${id}`, { op: "veto", id: id.toString() })}
        onPay={(id) => asMaster(`Payment of item ${id}`, { op: "pay", id: id.toString() })}
      />

      <div className="grid">
        <div className="stack">
          <section className="card" aria-labelledby="balance">
            <h2 id="balance">Balance</h2>
            <div className="big">{known ? eth(known.balance) : readFailed ? "Unknown" : "…"}</div>
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
            {!known && readFailed && <div className="sub">The read failed, so nothing is claimed about this account right now.</div>}
            {known && readFailed && <div className="sub">The latest read failed. These figures are from {age} seconds ago.</div>}
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
            {NETWORKS[network].directToMempool && (
              <p className="sub">
                Sending does not use {NETWORKS[network].label}: the transaction goes straight to the mempool, which sees your IP. Your reads stay on the mixnet.
              </p>
            )}
          </section>

          <SignedBy daily={lastDaily} master={lastMaster} />

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
            <div className="big">{leaves ?? "Unknown"}</div>
            <div className="sub">
              {leaves === null ? "The signer is not connected, so nothing is claimed about its keys." : `one-time keys left of ${ROTATION_LEAF}, plus one reserved for rotation.`} {SIGNER_TEXT[bridge.signer]}
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

          {bridge && (
            <OneTimeKeys root={bridge.root} nextLeaf={bridge.nextLeaf} writer={bridge.registryWriter} hardware={bridge.signer === "esp32"} ready={status === "ready"} directOnly={!!NETWORKS[network].directToMempool} tick={operations} />
          )}

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
        What is private here: {NETWORKS[network].private ? "your reads, and " : ""}your harbor until you escape. What is not: balances, rules and the queue are public on chain, and transactions leave from this machine directly. Hidden balances are not built. Devnet only, chain {DEVNET.chainId}.
      </p>
    </>
  );
}
