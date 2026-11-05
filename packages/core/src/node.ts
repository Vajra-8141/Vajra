/** The parts of the client that need a filesystem, kept out of the browser bundle. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import type { SignerState, SignerStore } from "./signer.ts";

export function loadOrCreateKey(path: string): Hex {
  if (existsSync(path)) return readFileSync(path, "utf8").trim() as Hex;
  const key = generatePrivateKey();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

/** Atomic on disk, so a crash cannot forget a leaf that already left. */
export function fileStore(path: string): SignerStore {
  return {
    load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SignerState) : undefined),
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 1), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}
