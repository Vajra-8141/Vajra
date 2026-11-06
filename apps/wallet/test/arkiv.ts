/** A hash key action on the public chain, from the last test wallet, checking the record lands on Arkiv and is read back. Needs a running server.ts. */
import { readFileSync } from "node:fs";
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
(globalThis as any).VAJRA_API = process.env.VAJRA_API ?? "http://127.0.0.1:8791";
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const snark = (await import(req.resolve("snarkjs"))) as any;
const root = new URL("../../../", import.meta.url).pathname;
const prover = snark.default ?? snark;
(globalThis as any).snarkjs = { groth16: { fullProve: (i: unknown, w: string) => { const c = w.includes("recovery") ? "recovery" : "unshield"; return prover.groth16.fullProve(i, `${root}circuits/build/${c}/${c}_js/${c}.wasm`, `${root}circuits/build/${c}/${c}.zkey`); } } };
const { engine } = await import("../src/engine.ts");
const log = (l: string) => console.log("    ·", l);
await engine.restore(readFileSync(new URL("../../../.vajra-wallet/test-backup.txt", import.meta.url), "utf8"), "horse battery staple river", log);
let s = await engine.snapshot();
console.log("wallet", s.account.slice(0, 10), "balance", s.balance, "frozen", s.frozen, "left", s.hashKeyLeft, "arkiv", JSON.stringify(s.arkiv));
const d = await engine.freeze(log);
console.log("freeze", d.hash.slice(0, 12), "arkiv", d.arkiv);
const u = await engine.unfreeze(log);
console.log("unfreeze", u.hash.slice(0, 12), "arkiv", u.arkiv);
if (process.env.MORE) {
  const payee = "0x000000000000000000000000000000000000dEaD" as const;
  const sent = await engine.send(payee, "0.0002", log);
  console.log("spend", sent.route, sent.hash.slice(0, 12));
  const theft = await engine.drill(log);
  console.log("drill", theft.route);
  if (theft.route === "queued") console.log("not me", (await engine.notMe(theft.id, log)).hash.slice(0, 12));
  const shield = await engine.shield(log);
  console.log("shield", shield.hash.slice(0, 12));
  const note = (await engine.snapshot()).notes.find((n) => !n.spent);
  if (note) { const out = await engine.unshield(note.id, payee, log); console.log("unshield", out.hash.slice(0, 12), "verify", out.verifyGas, "refused:", out.canonicalRefusal?.slice(0, 60)); }
}
await new Promise((r) => setTimeout(r, 4000));
s = await engine.snapshot();
console.log("after: left", s.hashKeyLeft, "arkiv", JSON.stringify(s.arkiv));
process.exit(0);
