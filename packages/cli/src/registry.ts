/**
 * This machine's link to the leaf registry on Arkiv, configured from `.env`: `ARKIV` is the access key and
 * `DEV_WALLET_PRIVATE_KEY` pays for the writes. Without them there is no registry, and everything still works on the signer's
 * counter and the chain's nonce. `ARKIV_WRITERS` lists the other wallets, comma separated, whose reservations this one respects.
 */
import { isLocalStack } from "@vajra/core";
import { type Address, type Hex } from "viem";
import { TreeExhausted } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { LeafRegistryWriter, type LeafSnapshot, type UseRecord, firstFreeLeaf, leafState } from "@vajra/core/registry";
import { keyPath } from "./deploy.ts";

type Log = (line: string) => void;

/** These never wait on a reservation, anyone's or their own: the way out must not depend on Arkiv. */
const URGENT = new Set(["freeze", "escape"]);

export class LeafUsedElsewhere extends Error {
  constructor(leaf: number) {
    super(`leaf ${leaf} has already signed something else: Arkiv holds the signature. This copy of the key is behind, so it must not sign.`);
    this.name = "LeafUsedElsewhere";
  }
}

export class LeafReservedElsewhere extends Error {
  constructor(leaf: number) {
    super(`another copy of this key has reserved leaf ${leaf}. Wait for it to finish, or for the reservation to expire in up to 5 minutes.`);
    this.name = "LeafReservedElsewhere";
  }
}

let shared: LeafRegistryWriter | null | undefined;

/** Replaces the registry, for tests. */
export const useRegistry = (registry: LeafRegistryWriter | null) => {
  shared = registry;
};

export function theRegistry(): LeafRegistryWriter | null {
  // The mirror's keys are throwaway, and a public registry is no place for them.
  if (isLocalStack) return null;
  if (shared !== undefined) return shared;
  const { ARKIV: accessKey, DEV_WALLET_PRIVATE_KEY: raw, ARKIV_WRITERS: others } = process.env;
  if (!accessKey || !raw) return (shared = null);
  shared = new LeafRegistryWriter({
    accessKey,
    privateKey: (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex,
    holder: loadOrCreateKey(keyPath("registry-holder.key")),
    writers: (others ?? "").split(",").filter(Boolean) as Address[],
  });
  return shared;
}

async function readLeaves(registry: LeafRegistryWriter, root: Hex, from: number, log: Log): Promise<LeafSnapshot | null> {
  const snapshot = await registry.snapshot(root, { from });
  if (!snapshot) log(`Arkiv did not answer (${registry.lastFailure}): going on with the signer's counter and the chain's nonce`);
  if (snapshot?.rejected) log(`Arkiv holds ${snapshot.rejected} records for this key that do not verify: ignored`);
  return snapshot;
}

export interface LeafRequest {
  root: Hex;
  leaf: number;
  account: Address;
  op: string;
  /** A software signer can move past a taken leaf. The hardware signer only counts forward by signing, so it has to refuse. */
  canSkip: boolean;
  log: Log;
}

/** Reads the registry, settles on a leaf, and reserves it before anything is revealed. */
export async function claimLeaf(o: LeafRequest): Promise<number> {
  const registry = theRegistry();
  if (!registry) return o.leaf;
  const urgent = URGENT.has(o.op);
  const snapshot = await readLeaves(registry, o.root, o.leaf, o.log);
  let leaf = o.leaf;
  if (snapshot && o.canSkip) {
    const free = firstFreeLeaf(snapshot, o.leaf, registry.holder);
    if (free === null) throw new TreeExhausted();
    if (free !== o.leaf) o.log(`Arkiv shows leaves ${o.leaf} to ${free - 1} taken: this copy of the key was behind, moving to leaf ${free}`);
    leaf = free;
  } else if (snapshot) {
    const state = leafState(snapshot, o.leaf, registry.holder);
    if (state === "used") throw new LeafUsedElsewhere(o.leaf);
    if (state === "reserved" && !urgent) throw new LeafReservedElsewhere(o.leaf);
    if (state === "reserved") o.log(`another copy of this key holds leaf ${o.leaf} on Arkiv: going on, because this is ${o.op}`);
  }
  const reserving = registry.reserve(o.root, leaf, o.account).then(
    (entity) => o.log(`reserved leaf ${leaf} on Arkiv: ${entity}`),
    (error: Error) => o.log(`the reservation was not written: ${error.message}`),
  );
  if (!urgent) await reserving;
  return leaf;
}

/** Publishes a signature that has left this machine. A write that fails is reported and not retried. */
export async function publishUse(use: UseRecord, log: Log): Promise<void> {
  const registry = theRegistry();
  if (!registry) return;
  await registry.recordUse(use).then(
    (entity) => log(`recorded leaf ${use.leaf} on Arkiv: ${entity}`),
    (error: Error) => log(`the usage record was not written: ${error.message}`),
  );
}
