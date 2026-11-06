/**
 * Reads docs/evidence at build or render time, on the server, and says plainly what each record is. A file with no entry below
 * still appears, marked as unlabelled, so that nothing recorded can go missing from the page.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The public devnet was reset on this day. Anything recorded on it before then can no longer be looked up. */
const RESET = Date.parse("2026-11-06T00:00:00Z");
const PUBLIC_CHAIN = 1337;
const MIRROR_CHAIN = 13370;

export type Origin = "public" | "public-before-reset" | "mirror" | "unknown";

export const ORIGINS: Record<Origin, { heading: string; text: string }> = {
  public: {
    heading: "Public devnet, after the reset",
    text: "Run against the public devnet, chain 1337, after its reset of 2026-11-06. The devnet can reset again, so a hash here may stop resolving.",
  },
  "public-before-reset": {
    heading: "Public devnet, before the reset",
    text: "Run against the public devnet before its reset of 2026-11-06. These hashes can no longer be looked up, so this file is the only record.",
  },
  mirror: {
    heading: "Local mirror",
    text: "Run on a local mirror, chain 13370. This is not public evidence. Each mirror starts from an empty chain, so rerun the command to see it yourself.",
  },
  unknown: { heading: "Not labelled", text: "No label has been written for these files yet, so nothing is claimed about where they ran." },
};

export interface EvidenceTx {
  step: string;
  hash: string;
  block: number | null;
  verifyGas: number | null;
}

export interface EvidenceRecord {
  file: string;
  title: string;
  what: string;
  command: string | null;
  origin: Origin;
  chainId: number | null;
  at: string | null;
  account: string | null;
  facts: [string, string][];
  transactions: EvidenceTx[];
  refusals: { attack: string; refusal: string }[];
}

type Raw = Record<string, unknown>;
const text = (value: unknown) => (value === undefined || value === null ? null : String(value));
const count = (value: unknown) => (typeof value === "number" ? value.toLocaleString("en-US") : null);

const LABELS: Record<string, { title: string; what: string; command?: string; facts?: (r: Raw) => [string, string | null][] }> = {
  "e2e-latest.json": { title: "The rulebook, end to end", what: "Every daily-key and master-key path, and every attack the rulebook claims to stop.", command: "vajra e2e" },
  "stealth-latest.json": {
    title: "A stealth spend with no ETH anywhere",
    what: "Received through an ML-KEM-768 announcement, spent with a hash signature and a co-signature, gas paid by a paymaster.",
    command: "vajra stealth",
    facts: (r) => [
      ["Frame gas: validate, pay, transfer", Array.isArray(r.frameGas) ? r.frameGas.map((g) => Number(g).toLocaleString("en-US")).join(" / ") : null],
      ["Canonical verdict", text(r.canonicalVerdict)],
    ],
  },
  "compare-latest.json": {
    title: "One proof transaction, three answers",
    what: "The sidecar as first deployed, the canonical mempool, and the patched sidecar, given the same recovery transaction.",
    command: "vajra compare",
    facts: (r) => [
      ["Sidecar as deployed at 2e22ff0", text((r.unpatched as Raw)?.refused)],
      ["Canonical mempool", text((r.canonical as Raw)?.refused)],
      ["Patched sidecar, VERIFY gas", count((r.patched as Raw)?.verifyGas)],
    ],
  },
  "recovery-public-latest.json": { title: "Recovery by proof, on the public devnet", what: "The whole recovery story, mined through the public alt mempool once it allowed precompiles.", command: "vajra recover", facts: (r) => [["VERIFY gas of a proof", count(r.verifyGas)], ["Failures", count(r.failures)]] },
  "shield-public-latest.json": { title: "One note through the pool, on the public devnet", what: "One note in and out. The pool held one note, so this proves the path, not any privacy.", command: "vajra shield, then vajra unshield", facts: (r) => [["Failures", count(r.failures)]] },
  "recovery-latest.json": { title: "Recovery by proof, every attack", what: "A Groth16 proof replaces a lost hash key, after a delay the owner can veto.", command: "vajra recover", facts: (r) => [["VERIFY gas of a proof", count(r.verifyGas)], ["Prover time, ms", count(r.proverMs)]] },
  "shielded-latest.json": { title: "The shielded pool, every attack", what: "Notes in with the master key, notes out with no key.", command: "vajra shielded", facts: (r) => [["VERIFY gas of an unshield", count(r.unshieldVerifyGas)], ["Prover time, ms", count(r.proverMs)]] },
  "recovery-public-latest.json": { title: "Recovery by proof, on the public devnet", what: "The same flow and attacks as on the mirror, with a Groth16 proof replacing a lost hash key.", command: "vajra recover" },
  "shield-public-latest.json": { title: "One note in and out, on the public devnet", what: "The pool held one note, so this proves the path, not any privacy.", command: "vajra shield, vajra unshield" },
  "clear-sign-latest.json": { title: "A wallet signing typed data, every attack", what: "A scripted wallet signs the asset, recipient, amount and cost as EIP-712 typed data.", command: "vajra clear-sign" },
  "exit-latest.json": { title: "The second way out, every attack", what: "VajraExit, a sender of its own: an escape mined past a thief's pending transaction.", command: "vajra exit-e2e" },
  "paymaster-latest.json": { title: "Quota and USDC paymasters, every attack", what: "Sponsored daily transactions, with the simulator's predictions held against what the nodes did.", command: "vajra paymaster-e2e" },
  "escape-solvency-attack-latest.json": { title: "An escape the mempool will not hold", what: "A thief spends the ETH the owner's escape needs to pay for itself.", command: "vajra escape-solvency" },
  "escape-solvency-fixed-latest.json": { title: "The way round an escape with no ETH", what: "The same attack, then the exit carries the tokens out from its own reserve.", command: "vajra escape-solvency fixed" },
  "proof-spam-pre-fix-latest.json": { title: "Proof spam, before the fix", what: "One note in many places, a note burning fees, and a public ticket, on the contract as it was.", command: "vajra proof-spam" },
  "proof-spam-fixed-latest.json": { title: "Proof spam, after the fix", what: "The same three attacks on the fixed contract.", command: "vajra proof-spam fixed" },
  "rep-burn-attack-latest.json": { title: "A thief banning the account on a node", what: "Junk transactions burn the account's reputation until its own transactions are refused.", command: "vajra rep-burn" },
  "rep-burn-fixed-latest.json": { title: "The way round a banned account", what: "The same attack, then escape, veto and recovery from the exit.", command: "vajra rep-burn fixed" },
  "rep-burn-sidecar-rule-latest.json": { title: "The same attack on the proposed sidecar rule", what: "With docs/upstream/sidecar-reputation.patch on the sidecar.", command: "vajra rep-burn rule" },
  "zk-gas-latest.json": { title: "Gas of the proof paths", what: "Measured with ethrex_simulateFrameTransaction, a fresh proof per sample.", command: "vajra measure-zk", facts: (r) => [["Recovery VERIFY, median", count((r.recoveryVerify as Raw)?.median)], ["Unshield VERIFY, median", count((r.unshieldVerify as Raw)?.median)]] },
  "device-esp32-latest.json": { title: "The hash key on an ESP32", what: "Master operations signed on a real board, each confirmed on its screen.", command: "vajra device-e2e" },
  "device-emulator-latest.json": { title: "The device path on an emulator", what: "The same protocol against a test harness. This is not hardware.", command: "vajra device-e2e" },
  "device-dashboard-latest.json": {
    title: "The dashboard with a real board",
    what: "Master operations from the dashboard, signed on the ESP32.",
    facts: (r) => [["Wallet", text(r.wallet)], ["Reads", text(r.reads)], ["Checks passed", count((r.checks as Raw)?.passed)], ["Checks failed", count((r.checks as Raw)?.failed)]],
  },
  "arkiv-latest.json": { title: "One-time key uses on Arkiv", what: "Reservations and signatures published to Arkiv, for an account on the public devnet.", command: "vajra arkiv", facts: (r) => [["Arkiv chain", text(r.arkivChain)], ["Entries", Array.isArray(r.entries) ? String(r.entries.length) : null]] },
  "nonce-burn-deployed-contract-latest.json": { title: "The nonce-burn flaw, as first deployed", what: "A daily key burns one-time keys on the contract as it first shipped. This is the flaw, kept on record.", command: "vajra nonce-burn", facts: (r) => [["Keys burned", count(r.leavesBurned)], ["Escape afterwards", text(r.escape)]] },
  "nonce-burn-fixed-contract-latest.json": { title: "The nonce-burn flaw, fixed", what: "The same attack on the fixed contract.", command: "vajra nonce-burn fixed", facts: (r) => [["Keys burned", count(r.leavesBurned)], ["First refusal", text(r.firstRefusal)], ["Escape afterwards", text(r.escape)]] },
  "nonce-burn-v2-latest.json": { title: "The nonce-burn flaw on V2", what: "The same attack on VajraAccountV2.", command: "vajra nonce-burn v2", facts: (r) => [["Keys burned", count(r.leavesBurned)], ["First refusal", text(r.firstRefusal)], ["Escape afterwards", text(r.escape)]] },
  "stealth-theft-deployed-contract-latest.json": { title: "The stealth theft, as first deployed", what: "A sender takes a stealth payment back. This is the flaw, kept on record. It used a stand-in token and did not run on the public devnet.", command: "vajra stealth-theft", facts: (r) => [["Outcome", text(r.outcome)], ["Taken, of", r.taken === undefined ? null : `${r.taken} of ${r.of}`]] },
  "stealth-theft-fixed-contract-latest.json": { title: "The stealth theft, fixed", what: "The same theft on the fixed contract, with a stand-in token.", command: "vajra stealth-theft fixed", facts: (r) => [["Outcome", text(r.outcome)], ["Taken, of", r.taken === undefined ? null : `${r.taken} of ${r.of}`]] },
};

function originOf(chainId: number | null, at: string | null): Origin {
  if (chainId === MIRROR_CHAIN) return "mirror";
  if (chainId !== PUBLIC_CHAIN) return "unknown";
  const time = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return "unknown";
  return time < RESET ? "public-before-reset" : "public";
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export function loadEvidence(dir: string = join(process.cwd(), "../../docs/evidence")): EvidenceRecord[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as Raw;
      const label = LABELS[file];
      // The Arkiv record sits on Arkiv's own chain, and `devnet` names the chain its account lived on.
      const chainId = typeof raw.chainId === "number" ? raw.chainId : typeof raw.devnet === "number" ? raw.devnet : null;
      const at = text(raw.at ?? raw.ranAt);
      const steps = [...list<Raw>(raw.transactions), ...list<Raw>(raw.mined)];
      const transactions: EvidenceTx[] = steps.flatMap((t) =>
        typeof t.hash === "string" ? [{ step: text(t.step ?? t.op) ?? "unnamed", hash: t.hash, block: typeof t.block === "number" ? t.block : null, verifyGas: typeof t.verifyGas === "number" ? t.verifyGas : null }] : [],
      );
      if (typeof raw.spendTx === "string") transactions.push({ step: "stealth spend", hash: raw.spendTx, block: typeof raw.block === "number" ? raw.block : null, verifyGas: null });
      return {
        file,
        title: label?.title ?? file,
        what: label?.what ?? "No description has been written for this file.",
        command: label?.command ?? null,
        origin: label ? originOf(chainId, at) : "unknown",
        chainId,
        at,
        account: text(raw.account),
        facts: (label?.facts?.(raw) ?? []).filter((fact): fact is [string, string] => fact[1] !== null),
        transactions,
        refusals: list<{ attack: string; refusal: string }>(raw.refusals),
      };
    });
}
