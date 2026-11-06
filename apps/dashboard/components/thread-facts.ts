import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every number the landing page and the story quote, read from docs/evidence at build time, so that none of them is typed by hand. */
export interface ThreadFacts {
  e2e: { mined: number; refused: number };
  veto: { gas: number | null; hash: string | null };
  recovery: { mined: number; refused: number; gas: number; chainId: number };
  stealth: { hash: string; chainId: number };
  pool: { mined: number; refused: number; chainId: number };
  publicNote: { mined: number; chainId: number };
}

type Raw = Record<string, unknown>;
const read = (file: string) => JSON.parse(readFileSync(join(process.cwd(), "../../docs/evidence", file), "utf8")) as Raw;
const size = (value: unknown) => (Array.isArray(value) ? value.length : typeof value === "number" ? value : 0);

export function threadFacts(): ThreadFacts {
  const e2e = read("e2e-latest.json");
  const recovery = read("recovery-public-latest.json");
  const stealth = read("stealth-latest.json");
  const pool = read("shielded-latest.json");
  const note = read("shield-public-latest.json");
  const veto = (e2e.transactions as { step: string; hash: string; verifyGas?: number }[]).find((t) => t.step === "master veto");
  return {
    e2e: { mined: size(e2e.transactions), refused: size(e2e.refusals) },
    veto: { gas: veto?.verifyGas ?? null, hash: veto?.hash ?? null },
    recovery: { mined: size(recovery.mined), refused: size(recovery.refusals), gas: recovery.verifyGas as number, chainId: recovery.chainId as number },
    stealth: { hash: stealth.spendTx as string, chainId: stealth.chainId as number },
    pool: { mined: size(pool.mined), refused: size(pool.refusals), chainId: pool.chainId as number },
    publicNote: { mined: size(note.mined), chainId: note.chainId as number },
  };
}
