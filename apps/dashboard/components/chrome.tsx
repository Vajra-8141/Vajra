"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NETWORKS, type NetworkId, useReads } from "../lib/reads";

export function Chrome({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { network, status, error, choose } = useReads();
  const here = (href: string) => (path === href ? ("page" as const) : undefined);
  return (
    <div className="shell">
      <header className="top">
        <Link href="/" className="mark">
          VAJRA
        </Link>
        <nav className="nav" aria-label="Main">
          <Link href="/" aria-current={here("/")}>
            Account
          </Link>
          <Link href="/scanner" aria-current={here("/scanner")}>
            Exposure
          </Link>
          <Link href="/proof" aria-current={here("/proof")}>
            Proof
          </Link>
        </nav>
        <label className="reads" style={{ margin: 0, display: "flex" }}>
          <span className={`dot ${status === "ready" && !NETWORKS[network].private ? "exposed" : status}`} aria-hidden />
          Reads via
          <select value={network} onChange={(e) => choose(e.target.value as NetworkId)} aria-label="How chain reads are routed">
            {(Object.keys(NETWORKS) as NetworkId[]).map((id) => (
              <option key={id} value={id}>
                {NETWORKS[id].label}
              </option>
            ))}
          </select>
        </label>
      </header>
      {status === "starting" && NETWORKS[network].private && (
        <div className="banner">Connecting to {NETWORKS[network].label}. Nothing is read until the route is up, which can take a minute.</div>
      )}
      {status === "failed" && (
        <div className="banner error">
          {NETWORKS[network].label} is not available: {error}. Nothing is being read. Choose another route above to continue; the options marked not private expose your IP to the RPC.
        </div>
      )}
      {status === "ready" && !NETWORKS[network].private && (
        <div className="banner warn">Reads are not private on this route: the RPC can see your IP and every address you look up.</div>
      )}
      {children}
    </div>
  );
}
