"use client";

/**
 * What every page knows about the account: the bridge, the chain, and the last thing each key signed. It lives above the pages, so
 * moving between them does not forget a read or restart a countdown.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type AccountView, isLocalStack, readAccount, withTimeout } from "@vajra/core";
import { type BridgeStatus, type Health, type Signed, bridgeHealth, bridgeSigned, bridgeStatus } from "./bridge";
import { useReads } from "./reads";

/** A mixnet round trip can take many seconds. Past this, a read has failed and the page should say so. */
const READ_TIMEOUT_MS = 60_000;
/** The mirror makes a block every two seconds and costs nothing to read. */
const POLL_PAUSE_MS = isLocalStack ? 2_000 : 8_000;
const SIGNED_POLL_MS = 2_000;
const HEALTH_POLL_MS = 3_000;

interface AccountState {
  /** null until the first answer. "down" when the bridge did not answer. */
  bridge: BridgeStatus | null | "down";
  health: Health | null;
  account: `0x${string}` | null;
  chain: AccountView | null;
  readAt: number | null;
  readFailed: boolean;
  now: number;
  lastDaily: Signed | null;
  lastMaster: Signed | null;
  /** Changes after each master operation, which is when there is something new to read on Arkiv. */
  operations: number;
  setLastDaily: (signed: Signed) => void;
  setLastMaster: (signed: Signed) => void;
  refreshBridge: () => Promise<void>;
  refreshChain: () => Promise<void>;
  countOperation: () => void;
}

const AccountContext = createContext<AccountState | null>(null);
export const useAccount = () => useContext(AccountContext)!;

export function AccountProvider({ children }: { children: ReactNode }) {
  const { status } = useReads();
  const [bridge, setBridge] = useState<AccountState["bridge"]>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [chain, setChain] = useState<AccountView | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [operations, setOperations] = useState(0);
  const [lastDaily, setLastDaily] = useState<Signed | null>(null);
  const [lastMaster, setLastMaster] = useState<Signed | null>(null);
  const reading = useRef(false);
  const seenSigned = useRef<{ daily?: string; master?: string }>({});

  const account = bridge && bridge !== "down" ? bridge.account : null;
  const refreshBridge = useCallback(() => bridgeStatus().then(setBridge, () => setBridge("down")), []);

  // A new account, after "start over", must not show the old one's figures for even one frame.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (shown.current !== null && shown.current !== account) {
      setChain(null);
      setReadAt(null);
    }
    shown.current = account;
  }, [account]);

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
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const answer = await bridgeHealth().catch(() => null);
      if (!live) return;
      setHealth(answer);
      await refreshBridge();
      if (live) timer = setTimeout(poll, HEALTH_POLL_MS);
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
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

  // A phone tap and the thief's terminal sign in other processes. Only a new hash counts, so a spend made here is not overwritten.
  useEffect(() => {
    if (!account) return;
    const timer = setInterval(async () => {
      const signed = await bridgeSigned().catch(() => null);
      if (signed?.daily && signed.daily.hash !== seenSigned.current.daily) {
        seenSigned.current.daily = signed.daily.hash;
        setLastDaily(signed.daily);
      }
      if (signed?.master && signed.master.hash !== seenSigned.current.master) {
        seenSigned.current.master = signed.master.hash;
        setLastMaster(signed.master);
        // As in the account page: the key just used is ours, so learn that before the next read of the chain.
        await refreshBridge();
        setOperations((n) => n + 1);
      }
    }, SIGNED_POLL_MS);
    return () => clearInterval(timer);
  }, [account, refreshBridge]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const countOperation = useCallback(() => setOperations((n) => n + 1), []);

  const value = useMemo(
    () => ({ bridge, health, account, chain, readAt, readFailed, now, lastDaily, lastMaster, operations, setLastDaily, setLastMaster, refreshBridge, refreshChain, countOperation }),
    [bridge, health, account, chain, readAt, readFailed, now, lastDaily, lastMaster, operations, refreshBridge, refreshChain, countOperation],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
