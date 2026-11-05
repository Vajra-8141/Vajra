"use client";

/**
 * Where every chain read and write goes.
 *
 * Who is protected, and who is checking their exposure, is metadata worth hiding, so reads default to an anonymizing
 * network. If that network fails, the dashboard stops and says so. It never falls back to a direct connection on its
 * own: switching to one that hides nothing is a choice the user has to make with their eyes open.
 */
import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { setRpcFetch } from "@vajra/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const BOOTSTRAP_RPC = "https://ethereum-rpc.publicnode.com";

export type NetworkId = "tor" | "nym" | "passthrough" | "direct";

interface Network {
  label: string;
  specifier?: `0x${string}`;
  config?: unknown;
  private: boolean;
}

export const NETWORKS: Record<NetworkId, Network> = {
  nym: { label: "Nym mixnet", specifier: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0", private: true },
  tor: {
    label: "Tor",
    specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    config: { gateways: ["152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ"] },
    private: true,
  },
  passthrough: { label: "Passthrough, not private", specifier: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27", private: false },
  direct: { label: "Direct, not private", private: false },
};

type Status = "starting" | "ready" | "failed";

interface Reads {
  network: NetworkId;
  status: Status;
  error: string | null;
  choose: (network: NetworkId) => void;
}

const ReadsContext = createContext<Reads | null>(null);
export const useReads = () => useContext(ReadsContext)!;

const bootstrap = {
  request: async ({ method, params }: { method: string; params?: unknown[] | object }) => {
    const response = await fetch(BOOTSTRAP_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
    });
    const { result, error } = await response.json();
    if (error) throw new Error(error.message);
    return result;
  },
};

const blocked: typeof fetch = () => Promise.reject(new Error("no read path: the anonymizing network is not available"));

export function ReadsProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<NetworkId>("nym");
  const [status, setStatus] = useState<Status>("starting");
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<AnonRpcWorker | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("vajra.reads") as NetworkId | null;
      if (saved && saved in NETWORKS) setNetwork(saved);
    } catch {
      // Private windows can refuse storage. The default is the safe one anyway.
    }
  }, []);

  useEffect(() => {
    let live = true;
    const chosen = NETWORKS[network];
    setStatus("starting");
    setError(null);
    setRpcFetch(blocked);
    worker.current?.close();
    worker.current = null;

    if (!chosen.specifier) {
      setRpcFetch((...args) => fetch(...args));
      setStatus("ready");
      return;
    }

    const started = new AnonRpcWorker({ address: chosen.specifier, config: chosen.config, preExisting: { rpcProvider: bootstrap } } as never);
    worker.current = started;
    started.ready.then(
      () => {
        if (!live) return;
        setRpcFetch(started.fetch as typeof fetch);
        setStatus("ready");
      },
      (reason: Error) => {
        if (!live) return;
        setError(reason.message);
        setStatus("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [network]);

  const choose = useCallback((next: NetworkId) => {
    setNetwork(next);
    try {
      localStorage.setItem("vajra.reads", next);
    } catch {
      // Remembering the choice is a convenience, nothing more.
    }
  }, []);

  const value = useMemo(() => ({ network, status, error, choose }), [network, status, error, choose]);
  return <ReadsContext.Provider value={value}>{children}</ReadsContext.Provider>;
}
