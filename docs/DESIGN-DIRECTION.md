# Design direction

**One idea: colour means rank.** The product is ink and hairlines until the hash key acts. The wallet is neutral, always. The one accent, arc blue, belongs to the master key, so a person can see who is in charge without reading anything.

The source of every value is `packages/shared/ui/tokens.css`. The dashboard, the extension and the phone all use it.

## The motif

A hash key signature is 67 chains of 16 steps: 2,144 bytes, 1,072 positions. That is not decoration, it is the key. So:

- The landing page is those 1,072 points, changing shape as the story moves. Vajra means both thunderbolt and diamond, so it opens as the double-ended bolt.
- Anywhere the hash key signs, a 67-bar line is drawn from that transaction's hash, the way a hash key picks its chains. It is labelled as a picture, not as the signature.

## The signature moment

The hash key outranking the wallet. On the landing page, scrolling past **Not me** floods the screen from the button outward in arc blue, and the page says so. In the product, the same thing happens small: the queued payment is cancelled, and the 67 bars appear on it. It happens only there.

## Rules

- One base, three surfaces, two hairlines. Most sections are separated by a hairline, not boxed. A surface means "this is the thing".
- Text at 100, 60 and 40, as `--t100`, `--t60`, `--t40`. All pass AA on every surface.
- `--arc` is for the hash key only: its actions, its panel, its signature. Primary buttons are white, because most primary actions are the wallet's.
- `--ok`, `--warn`, `--danger` are for state only. Never for decoration, never for emphasis.
- Geist for all interface text, Geist Mono for what a person might copy: addresses, hashes, commands, raw errors. Mono is not a label style.
- Sentence case. No all-caps labels. Tabular numbers everywhere.
- Spacing on the 8 point scale. Radius by size: 6 for chips, 10 for controls, 14 for surfaces, 22 for the phone.
- Touch targets 44px. No horizontal page scroll at 360px. Focus ring is a solid 2px, always visible.
- One primary action per screen. The key fact comes first.
- Every screen keeps loading, empty, error and success states. Unknown is written as unknown, never as zero.

## Navigation is the thread

Two groups, and the order is the argument.

- **Your money**: the story, the account.
- **Proof you can open**: break in, mempools, lifecycle, recorded runs, exposure.

Every proof page opens by naming the moment that made it necessary, and ends by pointing to the next one. Nothing is a feature list. If a page cannot name the moment that demands it, it goes behind one that can.

## Motion

- Product screens: only what answers a person. Hover and press 120ms, state change 200ms, the cancel moment 360ms. Nothing moves by itself except a countdown.
- Landing only: GSAP ScrollTrigger scrubs the field and the flood, Lenis smooths the wheel. Both are in the landing route's bundle and nowhere else.
- Scroll drives everything on the landing page, so the reader sets the pace. Nothing flashes.
- `prefers-reduced-motion`: no Lenis, no rotation, no flood, no entrances. The field still changes shape, as still frames, and all content reads in normal flow.

## Plain words

| The system says | We say | Kept where |
|---|---|---|
| secp256k1 key, EOA | your wallet, the daily key | proof pages name the curve |
| Winternitz, WOTS | the hash key | account panel, proof |
| Veto | cancel | "Veto" stays on the account queue button and in records |
| Queued item | a payment waiting in public | item numbers stay on the account |
| Harbor | your safe address | the term stays, with a tooltip |
| Escape | move everything to safety | the button stays "Escape to harbor" |
| Alt mempool, ERC-8421 | the second way in | the term stays, with a tooltip |
| Canonical mempool | the public way in | the term stays, with a tooltip |
| VERIFY gas | gas to verify | proof pages |
| ERC-8441 stealth, ML-KEM | paid privately | the story names them once |
| Groth16 proof | a proof of your paper secret | always with "Groth16 is not post-quantum" |

## Anti-patterns

- No gradient washes, glows, glass cards or grain. No colour for its own sake.
- No grids of identical cards. No icon-in-a-circle feature rows.
- No big-number stat strip. A number appears beside the sentence that needs it, with its source.
- No logos, testimonials, partners or invented numbers. Every number on the landing page comes from `docs/evidence/`, the README or the code.
- No hardware in the demo, drawn or implied.
- Never let polish hide a limit. "Local mirror", "demo signer", "the phone is a stand-in", "Groth16 is not post-quantum" and "the master key here is software" stay at normal text size, where the claim is.
- No effects on product routes. If it needs GSAP, it does not belong there.
