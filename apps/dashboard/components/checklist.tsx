"use client";

import { useEffect, useState } from "react";
import { DEVNET, isLocalStack, rpc } from "@vajra/core";
import { useAccount } from "../lib/account";
import { LANE, demoReset } from "../lib/bridge";

type State = "ok" | "todo" | "checking";

interface Line {
  id: string;
  label: string;
  state: State;
  /** What to do next, shown only while this line is not ok. */
  next?: string;
  command?: string;
}

const lanePrefix = LANE ? `VAJRA_LANE=${LANE} ` : "";

/** Asked from the browser, so that it still answers when the bridge is the thing that is down. */
function useProbe(url: string) {
  const [state, setState] = useState<State>("checking");
  useEffect(() => {
    let live = true;
    const ask = () =>
      rpc(url, "eth_chainId").then(
        () => live && setState("ok"),
        () => live && setState("todo"),
      );
    ask();
    const timer = setInterval(ask, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [url]);
  return state;
}

/** What is missing, in the order to fix it. It takes the place of a dead end, and disappears once there is nothing left to do. */
export function FirstRun() {
  const { bridge, health, refreshBridge } = useAccount();
  const chain = useProbe(DEVNET.execution);
  const sidecar = useProbe(DEVNET.mempool);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const bridgeState: State = bridge === null ? "checking" : bridge === "down" ? "todo" : "ok";
  const hasAccount = bridge !== null && bridge !== "down" && bridge.account !== null;
  const lines: Line[] = [];

  if (isLocalStack) {
    lines.push({ id: "chain", label: `The mirror is making blocks, chain ${DEVNET.chainId}`, state: chain, next: "Docker needs to be running, then boot the mirror. It prints GREEN when it is ready, in about a minute warm.", command: `${lanePrefix}make judge` });
    lines.push({ id: "sidecar", label: "The alt mempool is answering", state: sidecar, next: "It starts with the mirror. If the chain is up and this is not, boot the mirror again.", command: `${lanePrefix}make judge` });
  }
  lines.push({
    id: "bridge",
    label: "The bridge is running",
    state: bridgeState,
    next: "It holds the hash key, so this page never has to. This starts it and the page together.",
    command: isLocalStack ? `${lanePrefix}make dashboard` : "node packages/cli/src/main.ts bridge",
  });
  if (health?.stale) {
    lines.push({ id: "stale", label: "The bridge belongs to this chain", state: "todo", next: "The mirror was booted again after this bridge started, so it holds old addresses. Stop it and start it again.", command: `${lanePrefix}make dashboard` });
  }
  if (isLocalStack && health && !health.deployed) {
    lines.push({ id: "deployed", label: "The contracts are deployed", state: "todo", next: "The mirror is up but empty.", command: `${lanePrefix}make judge` });
  }
  lines.push({
    id: "account",
    label: "An account exists",
    state: bridgeState === "todo" ? "todo" : bridgeState === "checking" ? "checking" : hasAccount ? "ok" : "todo",
    next: isLocalStack ? (bridgeState === "ok" ? "Make one here. No wallet is needed." : "This comes after the bridge.") : "Connect your wallet and create it on the Account page.",
  });

  const missing = lines.filter((line) => line.state !== "ok");
  if (missing.length === 0) return null;
  if (missing.every((line) => line.state === "checking")) return <p className="sub">Checking what is running…</p>;
  const first = missing.find((line) => line.state === "todo");

  async function create() {
    setCreating(true);
    setProblem(null);
    try {
      await demoReset();
      await refreshBridge();
    } catch (e) {
      setProblem((e as Error).message);
    }
    setCreating(false);
  }

  return (
    <section className="firstrun" aria-labelledby="firstrun">
      <h2 id="firstrun">Before the story starts</h2>
      <p className="sub">Do the first open line. This list checks itself every few seconds, so there is nothing to reload.</p>
      {problem && <div className="banner error">{problem}</div>}
      <ol className="checks">
        {lines.map((line) => (
          <li key={line.id} className={`check ${line.state}`} data-check={line.id}>
            <span className="check-box" aria-hidden>
              {line.state === "ok" ? "✓" : ""}
            </span>
            <div>
              <div className="check-label">
                {line.label}
                <span className="visually-hidden">{line.state === "ok" ? ": done" : line.state === "checking" ? ": checking" : ": not yet"}</span>
              </div>
              {line.state === "todo" && line.id === first?.id && (
                <>
                  {line.next && <p className="check-next">{line.next}</p>}
                  {line.command && <code className="command">{line.command}</code>}
                  {line.id === "account" && isLocalStack && bridgeState === "ok" && health?.deployed && (
                    <button className="primary" disabled={creating} onClick={create}>
                      {creating ? "Creating…" : "Create the demo account"}
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
