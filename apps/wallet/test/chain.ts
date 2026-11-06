/**
 * The engine, end to end on the public chain, with no fake anywhere. Runs the same engine.ts the browser runs, against a running server.ts.
 * Usage: VAJRA_API=http://127.0.0.1:8791 node apps/wallet/test/chain.ts [steps...]
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
(globalThis as any).VAJRA_API = process.env.VAJRA_API ?? "http://127.0.0.1:8791";
const require = createRequire(import.meta.url);
(globalThis as any).snarkjs = (await import(require.resolve("snarkjs"))).default ?? (await import(require.resolve("snarkjs")));
const { engine } = await import("../src/engine.ts");
const { zk } = await import("../src/engine/prove.ts");
const root = resolve(import.meta.dirname, "../../..");
const files: Record<string, string> = {};
zk.base = "@"; void files;
const orig = (globalThis as any).snarkjs.groth16.fullProve;
(globalThis as any).snarkjs = { groth16: { fullProve: (i: unknown, w: string, z: string) => { const c = w.includes("recovery") ? "recovery" : "unshield"; return orig(i, `${root}/circuits/build/${c}/${c}_js/${c}.wasm`, `${root}/circuits/build/${c}/${c}.zkey`); } } };

const want = new Set(process.argv.slice(2));
const on = (s: string) => want.size === 0 || want.has(s);
const log = (l: string) => console.log("    ·", l);
let fails = 0;
async function step(name: string, work: () => Promise<unknown>) {
  const t = Date.now();
  try {
    const r = await work();
    const d = r as { hash?: string; verifyGas?: number; canonicalRefusal?: string | null };
    console.log(`ok   ${name} (${Math.round((Date.now() - t) / 1000)}s)${d?.hash ? ` ${d.hash.slice(0, 12)} verify ${d.verifyGas}` : ""}${d?.canonicalRefusal ? ` | normal mempool: ${String(d.canonicalRefusal).slice(0, 70)}` : ""}`);
    return r;
  } catch (e) {
    fails++;
    console.log(`FAIL ${name}: ${(e as Error).message.slice(0, 300)}`);
    return null;
  }
}
const payee = "0x000000000000000000000000000000000000dEaD" as const;

await step("create", () => engine.create({ passphrase: "correct horse", dailyLimit: "0.002", delaySeconds: 40, safe: null }, log));
let s = await engine.snapshot();
console.log("     account", s.account, "balance", s.balance, "left", s.dailyLeft, "delay", s.delaySeconds, "hash key", s.hashKeyLeft);
if (on("spend")) await step("instant spend", () => engine.send(payee, "0.0005", log));
if (on("drill")) {
  const r = (await step("drill queues", () => engine.drill(log))) as { route: string; id: string } | null;
  console.log("     route", r?.route);
  if (r) await step("not me", () => engine.notMe(r.id, log));
}
if (on("pay")) {
  const r = (await step("big payment queues", () => engine.send(payee, "0.003", log))) as { id: string } | null;
  if (r) await step("pay, it's me", () => engine.payNow(r.id, log));
}
if (on("wait")) {
  const r = (await step("queue and wait", () => engine.send(payee, "0.0025", log))) as { id: string; executeAfter: number } | null;
  if (r) { for (;;) { const c = (await engine.snapshot()).chainTime!; if (c > r.executeAfter) break; await new Promise((x) => setTimeout(x, 3000)); } await step("finish after delay", () => engine.finishQueued(r.id, log)); }
}
if (on("freeze")) { await step("freeze", () => engine.freeze(log)); console.log("     frozen", (await engine.snapshot()).frozen); await step("unfreeze", () => engine.unfreeze(log)); }
if (on("limit")) await step("set limit", () => engine.setLimit("0.004", log));
if (on("stealth")) {
  const code = await engine.privateCode();
  await step("send privately", () => engine.sendPrivately(code, "0.0005", log));
  const found = (await step("scan", () => engine.scanPrivate(log))) as { id: string; amount: string }[] | null;
  console.log("     found", found?.length, found?.[0]?.amount);
  if (found?.[0]) await step("claim", () => engine.claimPrivate(found[0]!.id, payee, log));
}
if (on("pool")) {
  await step("top up", () => engine.topUp(log));
  await step("shield", () => engine.shield(log));
  const n = (await engine.snapshot()).notes[0];
  if (n) await step("unshield", () => engine.unshield(n.id, payee, log));
}
if (on("rotate")) await step("rotate", () => engine.rotate(log));
if (on("exit")) await step("exit setup", () => engine.setupExit(log));
let paper = "";
if (on("recover")) { const r = (await step("recovery paper", () => engine.setupRecovery(30, log))) as { paper: string } | null; paper = r?.paper ?? ""; }
if (on("backup")) {
  const b = await engine.backup(); engine.forget();
  await step("restore from backup", () => engine.restore(b, "correct horse", log));
}
if (on("exitout")) {
  if (!on("exit") || want.size) await step("exit setup", () => engine.setupExit(log));
  await step("escape by the second way out", () => engine.exitEscape(log));
  s = await engine.snapshot();
  console.log("     safe holds", s.safe.balance, "wallet", s.balance);
}
if (on("move")) {
  const link = await engine.moveHashKeyLink();
  console.log("     link length", link.length);
}
if (on("escape")) {
  await step("escape", () => engine.escape(log));
  s = await engine.snapshot();
  console.log("     safe holds", s.safe.balance, "wallet", s.balance);
  await step("send from safe", () => engine.sendFromSafe(payee, "0.0001", log));
}
if (on("recover") && paper) {
  const acct = s.account; engine.forget();
  await step("recover with paper", () => engine.recover(paper, acct, "new passphrase", log));
  s = await engine.snapshot();
  console.log("     hash key here", s.hashKeyHere, "left", s.hashKeyLeft);
}
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
