"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import { type Address, formatEther, isAddress, parseEther } from "viem";
import {
  type AccountView,
  DEVNET,
  ETH,
  ROTATION_LEAF,
  dailyTx,
  framesSucceeded,
  isLocalStack,
  ops,
  publicClient,
  queuedEvents,
  refusalName,
  submit,
} from "@vajra/core";
import { FirstRun } from "../../components/checklist";
import { Lattice } from "../../components/lattice";
import { OneTimeKeys } from "../../components/leaves";
import { PoolCard } from "../../components/pool-meter";
import { Term } from "../../components/term";
import { NextStep } from "../../components/thread";
import { useAccount } from "../../lib/account";
import { type BridgeStatus, createOnBridge, demoExecute, demoSpend, master } from "../../lib/bridge";
import { countdown, eth, explain, short } from "../../lib/format";
import { NETWORKS, useReads } from "../../lib/reads";
import { connectWallet, hasWallet, signWithWallet } from "../../lib/wallet";

/** How long `submit` keeps watching for a receipt, which over a mixnet is several slow round trips per check. */
const SUBMIT_TIMEOUT_MS = 420_000;

const SIGNER_TEXT: Record<BridgeStatus["signer"], string> = {
  software: "Held by a software signer on this machine, which malware here could reach.",
  esp32: "Held on your USB signer. Read each operation on its screen and press BOOT to approve. While it is plugged in, malware on this machine could copy it, so unplug it when you are done.",
  emulator: "Held by a device emulator: a test harness, not hardware.",
};

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
function Alarm({ items, now }: { items: AccountView["items"]; now: number }) {
  const heard = useRef(new Set<bigint>());
  useEffect(() => {
    if (items.some((item) => !heard.current.has(item.id))) beep();
    for (const item of items) heard.current.add(item.id);
  }, [items]);
  if (items.length === 0) return null;
  return (
    <div className="alarm" role="alert">
      {items.map((item) => {
        const left = Number(item.executeAfter) - now;
        return (
          <div key={item.id.toString()}>
            <strong>
              {eth(item.amount)} to <span className="mono">{short(item.recipient)}</span>
            </strong>
            <div>{left > 0 ? `Leaves in ${countdown(left)} unless you stop it. Was this you? Answer on your phone.` : "Matured. Anyone can execute it now."}</div>
          </div>
        );
      })}
    </div>
  );
}

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
          <span className="tag good">Hash key, the master key</span>
          <div>Winternitz hash key, 2,144 bytes. No curve to break.</div>
          <div className="sub">{master ? `${master.gas.toLocaleString()} gas to verify, ${short(master.hash)}` : "Nothing signed yet"}</div>
          {master && <Lattice hash={master.hash} />}
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
  const { bridge, health, account, chain, readAt, readFailed, now, lastDaily, lastMaster, operations, setLastDaily, setLastMaster, refreshBridge, refreshChain, countOperation } = useAccount();
  const [wallet, setWallet] = useState<Address | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  const say = useCallback((line: string) => setLog((l) => [...l.slice(-40), line]), []);
  const demo = health?.demo.available === true;

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
      countOperation();
    });

  const spend = () =>
    run("spend", async () => {
      const nonce = BigInt(await publicClient.getTransactionCount({ address: account! }));
      const unsigned = dailyTx({ account: account!, dailyKey: wallet!, nonce, calls: [ops.spend(ETH, to as Address, parseEther(amount))] });
      say("asking your wallet to sign");
      const { hash, receipt } = await submit(await signWithWallet(unsigned, wallet!), { log: say, timeoutMs: SUBMIT_TIMEOUT_MS });
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

  /** The same outcome as `spend`, signed by the mirror's demo signer instead of a wallet. */
  const spendAsDemo = () =>
    run("spend", async () => {
      say("the demo signer is signing");
      const spent = await demoSpend(to, amount);
      say(`mined ${short(spent.hash)} in block ${spent.block}`);
      setLastDaily({ gas: spent.verifyGas, hash: spent.hash });
      setNotice(spent.queued ? `Over the rules, so it was queued as item ${spent.queued.id}. It runs after the delay unless the master key vetoes it.` : "Sent.");
      setAmount("");
    });

  const executeAsDemo = (id: bigint) =>
    run("execute", async () => {
      const done = await demoExecute(id.toString());
      say(`mined ${short(done.hash)} in block ${done.block}`);
      setNotice(`Item ${id} ran.`);
    });

  const execute = (id: bigint) =>
    run("execute", async () => {
      const nonce = BigInt(await publicClient.getTransactionCount({ address: account! }));
      const unsigned = dailyTx({ account: account!, dailyKey: wallet!, nonce, calls: [ops.executeQueued(id)] });
      const { hash, receipt } = await submit(await signWithWallet(unsigned, wallet!), { log: say, timeoutMs: SUBMIT_TIMEOUT_MS });
      if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but the item did not run`);
      say(`mined ${short(hash)} in block ${Number(receipt.blockNumber)}`);
      setNotice(`Item ${id} ran.`);
    });

  if (bridge === null || bridge === "down") return <FirstRun />;

  const connect = (
    <button
      onClick={() => {
        setNotice("Waiting for your wallet. If no window opens, click its icon in the browser toolbar.");
        connectWallet().then(
          (address) => {
            setWallet(address);
            setNotice(null);
          },
          (e: Error) => {
            setNotice(null);
            setProblem(e.message);
          },
        );
      }}
      disabled={!hasWallet()}
    >
      {wallet ? short(wallet) : hasWallet() ? "Connect wallet" : "No wallet in this browser"}
    </button>
  );

  if (!account)
    return (
      <div className="stack">
        <h1 className="page-title">Your account</h1>
        {isLocalStack && <FirstRun />}
        <div>{connect}</div>
        {problem && <div className="banner error">{problem}</div>}
        <CreateAccount daily={wallet} onCreated={refreshBridge} />
      </div>
    );

  const known = chain;
  const age = readAt ? Math.max(0, now - Math.floor(readAt / 1000)) : null;
  const pending = known?.items.filter((i) => i.state === 1) ?? [];
  const usedShare = known && known.limit > 0n ? Number((known.spent * 100n) / known.limit) : null;
  const isDailyKey = wallet && known && wallet.toLowerCase() === known.dailyKey.toLowerCase();
  const leaves = bridge.leavesLeft;

  return (
    <>
      <h1 className="visually-hidden">Your account</h1>
      {bridge.rootMatches === false && <div className="banner error">ChainStateUnknown: the account's key tree is not this signer's. Nothing will be signed.</div>}
      {known?.frozen && <div className="banner frozen">Frozen. Every daily-key transaction is refused until the master key unfreezes the account.</div>}
      {problem && <div className="banner error">{problem}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      <Alarm items={pending} now={now} />

      <div className="grid">
        <div className="stack">
          <section className="card" aria-labelledby="balance">
            <h2 id="balance">Balance</h2>
            <div className="big">{known ? <><NumberFlow value={Number(formatEther(known.balance))} format={{ maximumFractionDigits: 6 }} /> ETH</> : readFailed ? "Unknown" : "…"}</div>
            <div className="sub mono break">{account}</div>
            {known && (
              <>
                {usedShare !== null && (
                  <div className={`meter ${usedShare >= 100 ? "full" : ""}`} role="img" aria-label={`${usedShare}% of the daily limit used`}>
                    <span style={{ width: `${Math.min(usedShare, 100)}%` }} />
                  </div>
                )}
                <div className="sub">
                  {eth(known.spent)} of {eth(known.limit)} used in the last 24 hours. New payees are capped at {eth(known.allowance)} until they cool.
                </div>
              </>
            )}
            {!known && readFailed && <div className="sub">The read failed, so nothing is claimed about this account right now.</div>}
            {known && readFailed && <div className="sub">The latest read failed. These figures are from {age} seconds ago.</div>}
          </section>

          <section className="card" aria-labelledby="spend">
            <h2 id="spend">Spend with the <Term id="daily-key" /></h2>
            <div className="connect">{connect}</div>
            {wallet && known && !isDailyKey && <div className="banner warn">This wallet is not the daily key, {short(known.dailyKey)}.</div>}
            <label>
              To
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} />
            </label>
            <label>
              Amount, ETH
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0001" inputMode="decimal" />
            </label>
            <div className="actions">
              <button className="primary" disabled={!!busy || !isDailyKey || !isAddress(to) || !amount} onClick={spend}>
                {busy === "spend" ? "Sending…" : "Sign and send"}
              </button>
              {demo && (
                <button disabled={!!busy || !isAddress(to) || !amount} onClick={spendAsDemo}>
                  Send with the demo signer
                </button>
              )}
            </div>
            {demo && (
              <p className="sub">
                <Term id="demo-signer">The demo signer</Term> is the mirror&apos;s throwaway daily key, signing on the bridge. It is not your wallet.
              </p>
            )}
            <p className="sub">Anything over the rules is not refused. It joins the public queue below, where it waits and can be cancelled.</p>
            {NETWORKS[network].directToMempool && (
              <p className="sub">
                Sending does not use {NETWORKS[network].label}: the transaction goes straight to the mempool, which sees your IP. Your reads stay on the mixnet.
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="queue">
            <h2 id="queue"><Term id="queue">Public queue</Term></h2>
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
                      <button disabled={!!busy || (!isDailyKey && !demo) || known?.frozen} aria-busy={busy === "execute"} onClick={() => (isDailyKey ? execute(item.id) : executeAsDemo(item.id))}>
                        Execute
                      </button>
                    )}
                    <button className="arc" disabled={!!busy} onClick={() => asMaster(`Veto of item ${item.id}`, { op: "veto", id: item.id.toString() })}>
                      Veto
                    </button>
                  </div>
                </div>
              );
            })}
          </section>

          <SignedBy daily={lastDaily} master={lastMaster} />
        </div>

        <div className="stack">
          <section className="card master" aria-labelledby="master">
            <h2 id="master"><Term id="hash-key">Hash key</Term>, the master key</h2>
            <div className="big">{leaves ?? "Unknown"}</div>
            <div className="sub">
              {leaves === null ? "The signer is not connected, so nothing is claimed about its keys." : `one-time keys left of ${ROTATION_LEAF}, plus one reserved for rotation.`} {SIGNER_TEXT[bridge.signer]}
            </div>
            <div className="actions">
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
            <h2 id="escape"><Term id="escape">Escape</Term></h2>
            <p className="sub">
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

          <PoolCard account={account} ready={status === "ready"} />

          <section className="card" aria-labelledby="activity">
            <h2 id="activity">This session</h2>
            <div className="log">
              {log.length === 0 ? "Nothing yet." : log.map((line, i) => <div key={i}>{line}</div>)}
              <div ref={bottom} />
            </div>
          </section>
        </div>
      </div>

      <NextStep href="/story" label="Not sure what to try?" why="The story walks this same account, one moment at a time." />
      <p className="note">
        What is private here: {NETWORKS[network].private ? "your reads, and " : ""}your harbor until you escape. What is not: balances, rules and the queue are public on chain, and transactions leave from this machine directly. Hidden balances are not built. Devnet only, chain {DEVNET.chainId}.
      </p>
    </>
  );
}
