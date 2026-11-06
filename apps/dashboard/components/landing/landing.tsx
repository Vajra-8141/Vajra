"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { isLocalStack } from "@vajra/core";
import { Lattice, chainLevels } from "../lattice";
import { Mark } from "../mark";
import type { ThreadFacts } from "../thread-facts";
import { Field, SCENE_COUNT } from "./field";
import "./landing.css";

/** The demo's own figures: `Pay the shop`, `Steal`, and the queue delay the account is created with. */
const SPEND = "0.005 ETH";
const THEFT = "0.5 ETH";
const DELAY_SECONDS = 120;
/** A public hash from the evidence, if there is one, so that even the picture is drawn from something real. */
const FALLBACK_HASH = "0".repeat(64);

function Chapter({ n, scene, title, then, children, art }: { n: number; scene: number; title: string; then?: string; children: ReactNode; art?: ReactNode }) {
  return (
    <section className="chap" data-scene={scene} id={`chapter-${n}`} aria-labelledby={`chapter-${n}-title`}>
      <div className="chap-body">
        <p className="chap-n">Moment {n}</p>
        <h2 id={`chapter-${n}-title`}>{title}</h2>
        <div className="chap-text">{children}</div>
        {art}
        {then && <p className="chap-then">{then}</p>}
      </div>
    </section>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function Landing({ facts }: { facts: ThreadFacts }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLSpanElement>(null);
  const hash = facts.veto.hash ?? FALLBACK_HASH;

  useEffect(() => {
    const page = root.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    gsap.registerPlugin(ScrollTrigger);
    if (!reduced) page.classList.add("is-live");

    const field = new Field(canvas.current!, chainLevels(hash));
    let anchors: { y: number; scene: number }[] = [];
    const measure = () => {
      const top = window.scrollY;
      anchors = [...page.querySelectorAll<HTMLElement>("[data-scene]")].map((el) => {
        const box = el.getBoundingClientRect();
        return { y: top + box.top + box.height / 2, scene: Number(el.dataset.scene) };
      });
      field.resize();
    };

    let time = 0;
    const paint = () => {
      const middle = window.scrollY + window.innerHeight / 2;
      let scene = 0;
      let u = 0;
      if (anchors.length) {
        const next = anchors.findIndex((a) => a.y > middle);
        if (next === -1) scene = anchors.at(-1)!.scene;
        else if (next > 0) {
          const a = anchors[next - 1]!;
          const b = anchors[next]!;
          const share = (middle - a.y) / (b.y - a.y);
          // Hold each shape through the middle of its chapter, and move between them.
          scene = a.scene + (b.scene - a.scene) * Math.min(1, Math.max(0, (share - 0.3) / 0.4));
          u = Math.min(1, share * 2 + 0.5);
        }
      }
      const narrow = window.innerWidth < 900;
      const hero = window.scrollY < window.innerHeight * 0.5;
      field.draw(Math.min(scene, SCENE_COUNT - 1), u, time, narrow ? { x: 0.5, y: hero ? 0.84 : 0.26, scale: hero ? 0.5 : 0.74 } : { x: 0.69, y: 0.52, scale: 0.92 });
      if (clock.current && Math.round(scene) === 3) {
        const left = Math.max(0, Math.round(DELAY_SECONDS * (1 - u * 0.85)));
        clock.current.textContent = `${Math.floor(left / 60)}m ${left % 60}s`;
      }
      const end = page.scrollHeight - window.innerHeight;
      page.style.setProperty("--progress", String(end > 0 ? Math.min(1, window.scrollY / end) : 0));
    };

    measure();
    paint();

    const context = gsap.context(() => {
      if (reduced) return;
      gsap.utils.toArray<HTMLElement>(".chap, .end").forEach((chapter) => {
        ScrollTrigger.create({ trigger: chapter, start: "top 72%", end: "bottom 28%", toggleClass: "on" });
      });
      // The signature moment: the hash key's colour spreads from the button, as far as the reader scrolls it.
      const tap = button.current!;
      const flood = fill.current!;
      const origin = () => {
        const box = tap.getBoundingClientRect();
        const pin = flood.getBoundingClientRect();
        return `${box.left + box.width / 2 - pin.left}px ${box.top + box.height / 2 - pin.top}px`;
      };
      gsap.fromTo(
        flood,
        { clipPath: () => `circle(0px at ${origin()})` },
        {
          clipPath: () => `circle(160vmax at ${origin()})`,
          ease: "power1.in",
          scrollTrigger: { trigger: ".flood", start: "top top", end: "45% top", scrub: true, invalidateOnRefresh: true },
        },
      );
    }, page);

    let lenis: Lenis | null = null;
    const smoothly = (seconds: number) => lenis?.raf(seconds * 1000);
    if (!reduced && !touch) {
      lenis = new Lenis();
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(smoothly);
      gsap.ticker.lagSmoothing(0);
    }

    const tick = (seconds: number) => {
      time = seconds;
      paint();
    };
    if (!reduced) gsap.ticker.add(tick);
    const still = () => paint();
    if (reduced) window.addEventListener("scroll", still, { passive: true });
    const resized = () => {
      measure();
      paint();
      ScrollTrigger.refresh();
    };
    window.addEventListener("resize", resized);
    ScrollTrigger.addEventListener("refresh", measure);
    document.fonts?.ready.then(resized);

    return () => {
      window.removeEventListener("resize", resized);
      window.removeEventListener("scroll", still);
      ScrollTrigger.removeEventListener("refresh", measure);
      gsap.ticker.remove(tick);
      gsap.ticker.remove(smoothly);
      lenis?.destroy();
      context.revert();
      page.classList.remove("is-live");
    };
  }, [hash]);

  return (
    <div className="land" ref={root}>
      <header className="land-top">
        <Link href="/" className="mark" aria-label="VAJRA, home">
          <Mark />
          VAJRA
        </Link>
        <nav className="land-nav" aria-label="Main">
          {isLocalStack && <span className="tag warn">Local mirror</span>}
          <Link className="land-link" href="/proof">
            Proof
          </Link>
          <Link className="button primary" href="/story">
            Start the demo
          </Link>
        </nav>
      </header>
      <div className="land-progress" aria-hidden />

      <div className="land-story">
        <div className="land-stage" aria-hidden>
          <canvas ref={canvas} />
        </div>

        <section className="land-hero" data-scene={0} aria-labelledby="land-title">
          <div className="land-hero-text">
            <h1 id="land-title">Keep your wallet. We put a bank around it.</h1>
            <p className="land-lead">And the vault key is one a quantum computer can&apos;t break.</p>
            <div className="actions">
              <Link className="button primary land-cta" href="/story">
                Start the demo
              </Link>
              <a className="land-link" href="#chapter-1">
                Follow one person&apos;s money
              </a>
            </div>
            <p className="land-fine">
              An Ethereum account on EIP-8141 frame transactions and the ERC-8421 alternative mempool. Devnet only. The points moving here are the hash key: 67 chains of 16 steps.
            </p>
          </div>
        </section>

        <Chapter n={1} scene={1} title="You spend" then="But the key that spends is also the key a thief can steal.">
          <p>MetaMask signs, as it always has. Inside a daily limit, money leaves at once. Nobody switches wallets, and nothing about daily life changes.</p>
          <dl className="art-row">
            <div>
              <dt>Paid the shop</dt>
              <dd>{SPEND}</dd>
            </div>
            <div>
              <dt>Signed by</dt>
              <dd>your wallet, the daily key</dd>
            </div>
          </dl>
        </Chapter>

        <Chapter n={2} scene={2} title="Your seed phrase is stolen" then="So the theft has to wait.">
          <p>In every other wallet, that is the end. The thief holds the same key you do, and the chain cannot tell you apart. So the rules stop asking who you are, and limit what the key can do.</p>
        </Chapter>

        <section className="chap" data-scene={3} id="chapter-2b" aria-labelledby="chapter-2b-title">
          <div className="chap-body">
            <h2 id="chapter-2b-title">The theft waits in public</h2>
            <div className="chap-text">
              <p>Anything over the limit is not refused. It goes into a queue on chain, in the open, with a clock on it. The thief cannot hide it, so your phone can buzz.</p>
            </div>
            <dl className="art-row">
              <div>
                <dt>Waiting to leave</dt>
                <dd>{THEFT}</dd>
              </div>
              <div>
                <dt>Leaves in</dt>
                <dd>
                  <span ref={clock}>2m 0s</span>
                </dd>
              </div>
            </dl>
            <p className="chap-fine">The figures in these moments are the demo&apos;s own: {SPEND}, {THEFT}, and a {DELAY_SECONDS}-second delay.</p>
          </div>
        </section>

        <section className="flood" data-scene={4} id="chapter-3" aria-labelledby="chapter-3-title">
          <div className="flood-pin">
            <div className="flood-before">
              <p className="chap-n">Moment 3</p>
              <h2 id="chapter-3-title">You cancel it from your phone</h2>
              <div className="chap-text">
                <p>One tap. That tap makes a hash key sign, on your own computer, and the phone never holds it.</p>
              </div>
              <div className="land-alert">
                <strong>Was this you?</strong>
                <p>{THEFT} is about to leave your account.</p>
                <span className="land-alert-button" ref={button}>
                  Not me
                </span>
              </div>
            </div>
            <div className="flood-fill" ref={fill}>
              <div className="flood-inner">
                <h2>The hash key outranks the wallet.</h2>
                <p className="flood-lead">Same account, two kinds of signature, and the hash one is in charge. The wallet you know is now the junior key.</p>
                <div className="scroll">
                  <table className="rank">
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className="visually-hidden">Compared</span>
                        </th>
                        <th scope="col">Daily key</th>
                        <th scope="col">Hash key</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row">A quantum computer can break it?</th>
                        <td>Yes</td>
                        <td>No curve to break</td>
                      </tr>
                      <tr>
                        <th scope="row">Signature size</th>
                        <td>65 bytes</td>
                        <td>2,144 bytes</td>
                      </tr>
                      <tr>
                        <th scope="row">Gas to verify</th>
                        <td>33,000 to 36,000</td>
                        <td>90,000 to 95,000</td>
                      </tr>
                      <tr>
                        <th scope="row">Can it change the rules?</th>
                        <td>No</td>
                        <td>Yes</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <Lattice hash={hash} label={`Drawn from a recorded veto on the public devnet, ${facts.veto.gas === null ? "gas not recorded" : `${fmt(facts.veto.gas)} gas to verify`}. A picture of its hash, not the signature.`} />
                <p className="flood-then">The master key in this demo is software, on a laptop. So the thief goes after your way out.</p>
              </div>
            </div>
          </div>
        </section>

        <Chapter n={4} scene={5} title="The thief blocks your exit" then="That is why the alt mempool has to exist.">
          <p>The thief keeps a transaction pending. The public mempool will not hold your escape next to it. The same signed bytes go to the alt mempool, and they are mined.</p>
          <div className="art-lanes">
            <div>
              <span>Public mempool</span>
              <code>A frame transaction in the other nonce-key domain is already pending for this sender</code>
            </div>
            <div>
              <span>Alt mempool</span>
              <code>admitted, mined, all frames succeeded</code>
            </div>
          </div>
          <p className="chap-fine">It holds while a thief transaction stays pending. On this idle devnet that means sending one every slot.</p>
        </Chapter>

        <Chapter n={5} scene={6} title="You get paid privately" then="Your money is safe and your receipts are private. One thing is left to lose.">
          <p>Someone pays you, and nobody can link it to you. A stealth payment over ML-KEM, spent with a hash signature and a co-signature, with gas paid by a paymaster and no ETH anywhere.</p>
          <p className="chap-fine">Recorded on the public devnet, chain {facts.stealth.chainId}. Not safe against a sender who also owns a quantum computer.</p>
        </Chapter>

        <Chapter n={6} scene={7} title="You lose the master key" then="And once the keys are safe, you want somewhere private to keep savings.">
          <p>A proof of the secret you keep on paper queues a new key tree. It waits in the same public queue, so if the paper was stolen, the old key can still cancel it.</p>
          <p className="chap-fine">
            On the public devnet: {facts.recovery.mined} mined, {facts.recovery.refused} refused, {fmt(facts.recovery.gas)} gas to verify. The public mempool refuses this transaction, so the alt mempool is its only way in. Groth16 is not post-quantum, so this path is weaker than the key it replaces.
          </p>
        </Chapter>

        <Chapter n={7} scene={8} title="You want private savings">
          <p>A pool inside the account, spent with a proof and no key. The rulebook survives in there: a freeze blocks a withdrawal, an escape drains it to your safe address, and the daily key cannot reach it at all.</p>
          <p className="chap-fine">
            The full suite ran on the local mirror: {facts.pool.mined} mined, {facts.pool.refused} refused. One note went in and out on the public devnet, which proves the path and no privacy. The pool hides which deposit paid, not that this account paid that recipient.
          </p>
        </Chapter>

        <section className="end" data-scene={9} aria-labelledby="end-title">
          <div className="end-inner">
            <h2 id="end-title">One account. Each step needed the last.</h2>
            <div className="end-cols">
              <div>
                <h3>Run on the public devnet</h3>
                <ul>
                  <li>
                    The rulebook and every attack on it: {facts.e2e.mined} mined, {facts.e2e.refused} refused.
                  </li>
                  <li>The blocked exit, and the same bytes through the alt mempool.</li>
                  <li>
                    Recovery by proof: {facts.recovery.mined} mined, {facts.recovery.refused} refused.
                  </li>
                  <li>Real MetaMask and a real phone: 0.5 ETH queued, and one tap cancelled it.</li>
                </ul>
              </div>
              <div>
                <h3>What this does not prove</h3>
                <ul>
                  <li>This is not production post-quantum cryptography. The parameters are unreviewed.</li>
                  <li>The master key here is software, on a laptop.</li>
                  <li>A thief still gets the daily limit.</li>
                  <li>Reviews of our own code found two critical bugs in the first contract. Both are fixed, and both are on record.</li>
                  <li>Devnet only. It can reset at any time.</li>
                </ul>
              </div>
            </div>
            <div className="end-actions">
              <Link className="button primary land-cta" href="/story">
                Start the demo
              </Link>
              <Link className="land-link" href="/proof">
                Read every recorded run
                <ArrowRight size={16} aria-hidden />
              </Link>
            </div>
            <p className="land-fine">
              To run everything yourself, on your own machine: <code>make judge</code>
            </p>
          </div>
        </section>
      </div>

      <footer className="land-foot">
        <p>
          <span lang="sa" className="deva">
            वज्र
          </span>{" "}
          is Sanskrit for both thunderbolt and diamond.
        </p>
        <nav aria-label="Every page">
          <Link href="/story">The story</Link>
          <Link href="/account">Account</Link>
          <Link href="/break-in">Try to break in</Link>
          <Link href="/mempool">Mempools</Link>
          <Link href="/lifecycle">Lifecycle</Link>
          <Link href="/proof">Proof</Link>
          <Link href="/scanner">Exposure</Link>
        </nav>
      </footer>
    </div>
  );
}
