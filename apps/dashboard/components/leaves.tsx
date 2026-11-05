"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { DEVNET, routedFetch } from "@vajra/core";
import { ARKIV_EXPLORER, LeafRegistry, type LeafSnapshot, leafState } from "@vajra/core/registry";

/** A mixnet round trip is slow, and nothing is waiting to sign here. */
const PATIENCE_MS = 60_000;
const SHOWN = 6;
/** This page never holds a leaf, so nothing it reads is its own. */
const NOBODY = `0x${"0".repeat(64)}` as Hex;

const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();

interface Props {
  root: Hex | null;
  nextLeaf: number | null;
  writer: Address | null;
  /** The hardware signer cannot move past a spent leaf, so the same fact means something different to each. */
  hardware: boolean;
  /** True once this page's private route is up. A read before that would have nowhere safe to go. */
  ready: boolean;
  /** Arkiv refuses what this route sends, so a read can only go direct, and only if the owner says so. */
  directOnly: boolean;
  /** Changes after each master operation, which is when there is something new to see. */
  tick: number;
}

/**
 * What Arkiv knows about this account's one-time keys. Every signature shown here was verified in this browser, so the page
 * takes nobody's word for it, including Arkiv's.
 */
export function OneTimeKeys({ root, nextLeaf, writer, hardware, ready, directOnly, tick }: Props) {
  const [allowed, setAllowed] = useState(false);
  const mustAsk = directOnly && !allowed;
  const registry = useMemo(
    () =>
      new LeafRegistry({
        accessKey: process.env.NEXT_PUBLIC_ARKIV_KEY ?? "",
        writers: writer ? [writer] : [],
        fetchFn: directOnly ? (...args) => fetch(...args) : routedFetch,
      }),
    [writer, directOnly],
  );
  const [snapshot, setSnapshot] = useState<LeafSnapshot | null>(null);
  const [state, setState] = useState<"reading" | "read" | "failed">("reading");

  const read = useCallback(async () => {
    if (!root || !ready || mustAsk) return;
    setState("reading");
    const next = await registry.snapshot(root, { patience: PATIENCE_MS });
    setSnapshot(next);
    setState(next ? "read" : "failed");
  }, [registry, root, ready, mustAsk]);

  useEffect(() => {
    void read();
  }, [read, tick]);

  const next = snapshot && nextLeaf !== null ? leafState(snapshot, nextLeaf, NOBODY) : null;
  const recent = snapshot ? [...snapshot.uses].sort((a, b) => b.at - a.at).slice(0, SHOWN) : [];

  return (
    <section className="card leaves" aria-labelledby="leaves">
      <h2 id="leaves">One-time keys on Arkiv</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        A key that signs twice can be forged, so every signature is published here. Your signer reads this before it signs, and any
        other wallet can too.
      </p>

      {mustAsk && (
        <>
          <div className="banner warn">
            Arkiv refuses requests from this private route, so this read cannot stay private. Reading it shows Arkiv your IP address and
            this key tree. Your signer checks Arkiv before signing either way, so nothing here is needed to stay safe.
          </div>
          <div className="actions">
            <button onClick={() => setAllowed(true)}>Read Arkiv directly</button>
          </div>
        </>
      )}

      {!mustAsk && state === "failed" && (
        <div className="banner warn">
          Arkiv did not answer: {registry.lastFailure}. Signing still works, on the signer&apos;s counter and the chain&apos;s nonce.
        </div>
      )}

      {next === "used" && (
        <div className="banner error next-leaf">
          Key #{nextLeaf} has already signed something else, so this copy of your key is behind.{" "}
          {hardware ? "The signer will refuse to sign until this is resolved." : "It will move past that key on its own."}
        </div>
      )}
      {next === "reserved" && (
        <div className="banner warn next-leaf">Another copy of this key holds key #{nextLeaf}. The hold ends on its own within 5 minutes.</div>
      )}

      {next === "free" && (
        <p className="next-leaf">
          Next key: #{nextLeaf} <span className="tag good">not used anywhere</span>
        </p>
      )}

      {snapshot && recent.length === 0 && <p className="sub">No key from this tree has been used yet.</p>}
      {recent.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Operation</th>
                <th>When</th>
                <th>Proof</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((use) => (
                <tr key={use.entity}>
                  <td>#{use.leaf}</td>
                  <td>{use.op}</td>
                  <td>{when(use.at)}</td>
                  <td>
                    <span className="tag good">signature verified</span>{" "}
                    <a href={`${ARKIV_EXPLORER}/entity/${use.entity}`} target="_blank" rel="noreferrer">
                      {short(use.entity)}
                    </a>
                    {use.txHash && (
                      <>
                        {" · "}
                        <a href={`${DEVNET.explorer}/tx/${use.txHash}`} target="_blank" rel="noreferrer">
                          tx
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {snapshot && snapshot.rejected > 0 && (
        <p className="sub forged">
          Ignored {snapshot.rejected} {snapshot.rejected === 1 ? "record" : "records"} claiming this key whose signature did not verify.
        </p>
      )}

      {!mustAsk && (
        <div className="actions" style={{ marginTop: 12 }}>
          <button disabled={state === "reading" || !ready || !root} onClick={() => void read()}>
            {state === "reading" ? "Reading Arkiv" : "Check again"}
          </button>
        </div>
      )}
    </section>
  );
}
