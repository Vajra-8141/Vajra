/**
 * The one seed every note comes from. It stands apart from the master seed, because a depositor may have no master key, the hardware
 * signer never lets its seed out, and a rotation or a recovery must not lose a note.
 *
 * Whoever holds it can spend every note it made and will ever make, so it is as sensitive as a key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";

const seedPath = keyPath("note-seed.key");

/** The local seed, made on first use. */
export function noteSeed(): Hex {
  if (!existsSync(seedPath)) console.log(`Your notes all come from one seed, in ${seedPath}.\nCopy it to paper or steel. With it and the account, \`vajra notes-restore\` finds every note again. Whoever holds it can spend them.`);
  return loadOrCreateKey(seedPath);
}

/** The seed on this machine, if there is one. */
export const localNoteSeed = (): Hex | null => (existsSync(seedPath) ? (readFileSync(seedPath, "utf8").trim() as Hex) : null);

/** Refuses to replace a different seed: it may be the only copy of other notes. */
export function installNoteSeed(seed: Hex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new Error("that is not a note seed: it should be 32 bytes of hex");
  const local = localNoteSeed();
  if (local && local.toLowerCase() !== seed.toLowerCase()) throw new Error(`REFUSED: a different note seed is already in ${seedPath}. Move it aside first: it may be the only copy of other notes.`);
  mkdirSync(dirname(seedPath), { recursive: true });
  writeFileSync(seedPath, seed, { mode: 0o600 });
}
