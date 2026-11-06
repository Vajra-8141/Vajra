"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEVNET, isLocalStack, rpcBatch } from "@vajra/core";
import type { Origin } from "../lib/evidence";
import { useReads } from "../lib/reads";

type State = "mined" | "gone" | "unknown";
const LiveContext = createContext<Record<string, State>>({});

/** Looks up recorded hashes on the public devnet. A mirror cannot answer for them, so it does not ask. */
export function LiveCheck({ hashes, children }: { hashes: string[]; children: ReactNode }) {
  const { status } = useReads();
  const [live, setLive] = useState<Record<string, State>>({});

  useEffect(() => {
    if (status !== "ready" || isLocalStack || hashes.length === 0) return;
    rpcBatch<unknown>(DEVNET.execution, hashes.map((hash) => ({ method: "eth_getTransactionReceipt", params: [hash] }))).then(
      (receipts) => setLive(Object.fromEntries(hashes.map((hash, i) => [hash, receipts[i] ? "mined" : "gone"]))),
      () => setLive(Object.fromEntries(hashes.map((hash) => [hash, "unknown"]))),
    );
  }, [status, hashes]);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function LiveTag({ hash, origin }: { hash: string; origin: Origin }) {
  const live = useContext(LiveContext);
  if (origin === "mirror") return <span className="tag">from an earlier mirror</span>;
  if (origin === "public-before-reset") return <span className="tag warn">gone with the reset</span>;
  if (isLocalStack) return <span className="tag">not checked from the mirror</span>;
  const state = live[hash];
  if (state === "mined") return <span className="tag good">on chain now</span>;
  if (state === "gone") return <span className="tag warn">not found, devnet may have reset</span>;
  return <span className="tag">{state === "unknown" ? "unknown" : "checking"}</span>;
}
