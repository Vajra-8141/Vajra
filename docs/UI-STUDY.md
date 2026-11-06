# UI study for the VAJRA redesign

Seen on 2026-11-06 in headless Brave: 1440x900 at the top plus 2 or 3 scrolled spots, and 390x844 at the top. We borrow principles only, never look, layout, assets or copy. A headless run shows stills, so anything about how motion feels is unverified unless noted.

## lusion.co (loaded; the page runs on its own scroller)
- One idea per screen. A single object fills the view, then one huge line, then one short paragraph. The pacing comes from what is left out.
- The hero and the next heading hand over to each other on scroll, so the page reads as one piece, not a stack of sections. A money story can work the same way.
- On phone, one short sentence at the top says what they do, then the object.
- Leave out: the long loader. It was still on screen after 7 seconds here on software WebGL, and it blocks all content. Judges on laptops should never wait for a picture.

## reactbits.dev (loaded; llms.txt read)
- Shows the real thing, not a claim: live code, presets and a working demo sit in the first view.
- One clear primary button, one quiet secondary. Phone stacks them full width.
- Each demo sits in its own frame, so effects don't fight each other.
- Leave out: the catalogue feel, with every card moving and a different effect in each. We need one voice.

## linear.app (loaded)
- Big plain headline, one grey line under it, then the real product straight away. The product is the picture.
- Section rhythm repeats: short title left, one sentence right, one link. Quick to scan, and it stays calm over a long page.
- Very low contrast chrome. Hairlines and greys carry structure, and white text carries meaning. A good model for our product screens.
- Leave out: faint text that drops close to invisible. Some mid-scroll content was almost unreadable in stills (could be a fade in progress), and a proof must stay readable.

## stripe.com (loaded; redirected to /in, an India version)
- One small live number above the headline; it differed between my two loads. It proves scale in a single line. Ours could be a real on-chain figure, or nothing.
- Two-tone sentences: dark for the claim, grey for the detail. One paragraph then does both jobs.
- Hard things get a choice of paths: no code, a platform, or your own build, each with a small real picture.
- Big numbers with tiny labels make a quiet proof band, and a dark section changes the mood mid-page.
- Leave out: length and sprawl. The page is about 14,800px with logos, stories and events. Our story has one person.

## vercel.com (loaded)
- Two word headline, one shape, three short lines. Whitespace does the selling.
- Each section pairs a real product view with one customer fact and a short feature list. Claim, picture, proof, in that order.
- On phone the order changes to shape, headline, buttons, and it still works in one screen.
- Leave out: the jargon headline. "Agentic Infrastructure" works for their crowd; ours has to make sense to someone who has never heard of a smart account.

## rabby.io (loaded; Rainbow also loaded, top view only)
- Each feature is one real wallet screen with one short label. A user learns the product by looking.
- Risk is shown at the moment of action: the connect screen flags a bad site right there, next to the button. Our guard should sit in the same place.
- Getting it is the first job: extension and mobile buttons are top of page, for the same two surfaces we ship.
- Rainbow keeps the balance and four actions at the top of its phone screen. A good order for our PWA.
- Leave out: walls of logos and a loud colour per card.

## kast.xyz (loaded)
- One word as the headline. It talks about money, not the tech under it.
- Plain verbs carry the sections: Spend, Move, then a line or two each. Real rows ("Payment to Paul", an amount, a time) sit on the pictures, so it feels lived in.
- A small calculator with tier buttons turns a rate into a sum of money. That teaches more than a paragraph would (seen, not clicked).
- It names who it is for, with one line of real life each. Good for our one-person story.
- Leave out: fashion photos, the sticky QR box over content, and yield rates as a hook. They sell a lifestyle, and our pitch is safety.

## Rules for VAJRA
1. One person, one amount of money, from top to bottom. The number on screen changes only when something happens to it.
2. One idea per screen on the landing page. If a scroll step has two ideas, split it.
3. Motion must say something: money moved, a theft was stopped, a key changed. If it says nothing, cut it.
4. Text and the first action show at once. No loader, and no effect may block reading. The page must also work with reduced motion and with WebGL off.
5. Product screens get no scroll effects. Balance first, then the few actions, then history. Keep transitions short and let hairlines and greys do the structure.
6. Show the real screen, not an illustration. Every claim on the landing page points to a real product view or a real on-chain record.
7. Say it in money words first (vault, stolen, cancelled, safe), with the crypto term second and smaller. Quantum gets one plain sentence.
8. Design the phone view first for each step, and show the warning right beside the button it is about, in the extension and the PWA too.

## React Bits worth considering (at most 6)
Names are from llms.txt; dependencies are from each entry in reactbits.dev/r. The code of every entry below mentions reduced motion, but how well that works is unverified until tried. Uncommitted work in apps/dashboard/package.json adds gsap and @number-flow/react, not motion. If that lands, number-flow may already do the job of `Counter` and `CountUp`.
- `ScrollReveal`: story text that clears as you scroll (gsap).
- `SplitText`: one headline entrance, used once (gsap, @gsap/react).
- `Counter`: rolling digits for the balance, with currency support (no npm deps). Good for "the number changes".
- `CountUp`: a one-off count for proof figures, but it adds motion as a new dependency. Try `Counter` there first.
- `AnimatedContent`: plain reveal wrapper for story blocks (gsap).
- `SoftAurora`: the one WebGL background, landing page only, and only behind the opening (no npm deps). `Grainient` is the backup. Never both.

License: MIT + Commons Clause, from the LICENSE.md in the React Bits GitHub repo (llms.txt does not state it). Using components inside our app is fine, commercial use included. We must keep the copyright notice in copied files and must not sell or redistribute the components on their own. React Bits Pro is a separate paid library; do not use it.
