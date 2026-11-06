"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DEVNET, isLocalStack } from "@vajra/core";
import { NETWORKS, type NetworkId, useReads } from "../lib/reads";

const PAGES = [
  ["/", "The theft"],
  ["/account", "Account"],
  ["/break-in", "Try to break in"],
  ["/mempool", "Mempools"],
  ["/lifecycle", "Lifecycle"],
  ["/scanner", "Exposure"],
  ["/proof", "Proof"],
] as const;

export function Chrome({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { network, status, error, choose } = useReads();
  return (
    <>
      <header className="top">
        <div className="top-inner">
          <Link href="/" className="mark" aria-label="VAJRA, home">
            <span className="mark-deva" lang="sa">
              वज्र
            </span>
            <span className="mark-latin">VAJRA</span>
          </Link>
          <nav className="nav" aria-label="Main">
            {PAGES.map(([href, label]) => (
              <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>
                {label}
              </Link>
            ))}
          </nav>
          <label className="reads">
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
        </div>
      </header>
      <div className="shell">
        {status === "starting" && NETWORKS[network].private && <div className="banner">Connecting to {NETWORKS[network].label}. Nothing is read until the route is up, which can take a minute.</div>}
        {status === "failed" && (
          <div className="banner error">
            {NETWORKS[network].label} is not available: {error}. Nothing is being read. Choose another route above to continue; the options marked not private expose your IP to the RPC.
          </div>
        )}
        {isLocalStack && <div className="banner warn mirror-note">Local mirror, chain {DEVNET.chainId}, on this machine. Nothing on this page is happening on the public devnet.</div>}
        {!isLocalStack && status === "ready" && !NETWORKS[network].private && <div className="banner warn">Reads are not private on this route: the RPC can see your IP and every address you look up.</div>}
        {children}
      </div>
    </>
  );
}
