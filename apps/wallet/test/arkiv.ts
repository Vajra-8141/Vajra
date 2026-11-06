/** A hash key action on the public chain, from the last test wallet, checking the record lands on Arkiv and is read back. Needs a running server.ts. */
import { readFileSync } from "node:fs";
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
(globalThis as any).VAJRA_API = process.env.VAJRA_API ?? "http://127.0.0.1:8791";
const { engine } = await import("../src/engine.ts");
const log = (l: string) => console.log("    ·", l);
await engine.restore(readFileSync(new URL("../../../.vajra-wallet/test-backup.txt", import.meta.url), "utf8"), "horse battery staple river", log);
let s = await engine.snapshot();
console.log("wallet", s.account.slice(0, 10), "balance", s.balance, "frozen", s.frozen, "left", s.hashKeyLeft, "arkiv", JSON.stringify(s.arkiv));
const d = await engine.freeze(log);
console.log("freeze", d.hash.slice(0, 12), "arkiv", d.arkiv);
const u = await engine.unfreeze(log);
console.log("unfreeze", u.hash.slice(0, 12), "arkiv", u.arkiv);
await new Promise((r) => setTimeout(r, 4000));
s = await engine.snapshot();
console.log("after: left", s.hashKeyLeft, "arkiv", JSON.stringify(s.arkiv));
process.exit(0);
