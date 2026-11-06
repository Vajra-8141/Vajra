"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { DEVNET, isLocalStack } from "@vajra/core";
import { NETWORKS, type NetworkId, useReads } from "../lib/reads";
import { Mark } from "./mark";

/** The order is the argument: the story first, then the proof you can open. */
const GROUPS = [
  {
    name: "Your money",
    pages: [
      ["/story", "The story"],
      ["/account", "Account"],
    ],
  },
  {
    name: "Proof you can open",
    pages: [
      ["/break-in", "Try to break in"],
      ["/mempool", "Mempools"],
      ["/lifecycle", "Lifecycle"],
      ["/proof", "Proof"],
      ["/scanner", "Exposure"],
    ],
  },
] as const;

export function Chrome({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { network, status, error, choose } = useReads();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  // The landing page brings its own header. Everything it says comes from the evidence, and it reads nothing live.
  if (path === "/") return <>{children}</>;

  return (
    <div className="app">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="top">
        <Link href="/" className="mark" aria-label="VAJRA, home">
          <Mark />
          VAJRA
        </Link>
        <button className="icon" aria-label={open ? "Close the menu" : "Open the menu"} aria-expanded={open} aria-controls="side" onClick={() => setOpen(!open)}>
          {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
        </button>
      </header>
      <aside id="side" className={`side ${open ? "open" : ""}`}>
        <Link href="/" className="mark side-mark" aria-label="VAJRA, home page">
          <Mark />
          VAJRA
        </Link>
        <nav className="nav" aria-label="Main">
          {GROUPS.map((group) => (
            <div key={group.name}>
              <p className="nav-group">{group.name}</p>
              {group.pages.map(([href, label]) => (
                <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <label className="reads">
          <span className="reads-label">
            <span className={`dot ${status === "ready" && !NETWORKS[network].private ? "exposed" : status}`} aria-hidden />
            Reads via
          </span>
          <select value={network} onChange={(e) => choose(e.target.value as NetworkId)} aria-label="How chain reads are routed">
            {(Object.keys(NETWORKS) as NetworkId[]).map((id) => (
              <option key={id} value={id}>
                {NETWORKS[id].label}
              </option>
            ))}
          </select>
        </label>
      </aside>
      <div className="shell" id="content">
        {status === "starting" && NETWORKS[network].private && <div className="banner">Connecting to {NETWORKS[network].label}. Nothing is read until the route is up, which can take a minute.</div>}
        {status === "failed" && (
          <div className="banner error">
            {NETWORKS[network].label} is not available: {error}. Nothing is being read. Choose another route in the menu to continue; the options marked not private expose your IP to the RPC.
          </div>
        )}
        {isLocalStack && <div className="banner warn mirror-note">Local mirror, chain {DEVNET.chainId}, on this machine. Nothing on this page is happening on the public devnet.</div>}
        {!isLocalStack && status === "ready" && !NETWORKS[network].private && <div className="banner warn">Reads are not private on this route: the RPC can see your IP and every address you look up.</div>}
        {children}
      </div>
    </div>
  );
}
