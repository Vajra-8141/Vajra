/**
 * The master key.
 *
 * This is a software signer holding the seed in a file. It keeps the interface a hardware device would have, and it
 * enforces the one rule that matters regardless of where the seed lives: a leaf reveals its secrets the moment a
 * signature leaves this module, and two signatures from one leaf over different digests let anyone forge a third.
 *
 * So the leaf is recorded before the signature is returned, and a recorded leaf will only ever repeat the signature it
 * already gave. A signature handed to a node for simulation has been revealed just as surely as one broadcast: callers
 * must treat `sign` as final.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Hex, bytesToHex, hexToBytes } from "viem";
import {
  KeyTree,
  ROTATION_LEAF,
  type Bytes,
  type WotsParams,
  encodeMasterSignature,
  verifyHashCount,
  wotsSign,
} from "./wots.ts";

export class LeafAlreadyRevealed extends Error {
  readonly leaf: number;

  constructor(leaf: number) {
    super(`REFUSED: leaf ${leaf} already revealed`);
    this.name = "LeafAlreadyRevealed";
    this.leaf = leaf;
  }
}

export class TreeExhausted extends Error {
  constructor() {
    super("REFUSED: tree exhausted, rotate");
    this.name = "TreeExhausted";
  }
}

export class ChainStateUnknown extends Error {
  constructor(expected: Hex, found: Hex) {
    super(`REFUSED: chain state unknown, this signer holds root ${expected} but the account has ${found}`);
    this.name = "ChainStateUnknown";
  }
}

export interface SignerState {
  seed: Hex;
  /** Lowest leaf never revealed. */
  nextLeaf: number;
  /** Everything ever revealed, by leaf: the digest it signed. */
  revealed: Record<number, Hex>;
}

export interface SignerStore {
  load(): SignerState | undefined;
  save(state: SignerState): void;
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

export function memoryStore(initial?: SignerState): SignerStore {
  let state = initial;
  return { load: () => state, save: (s) => void (state = structuredClone(s)) };
}

export class MasterSigner {
  readonly tree: KeyTree;
  readonly params: WotsParams;
  private readonly store: SignerStore;
  private state: SignerState;
  private readonly seed: Bytes;

  constructor(params: WotsParams, store: SignerStore, newSeed: () => Bytes) {
    this.params = params;
    this.store = store;
    const existing = store.load();
    this.state = existing ?? { seed: bytesToHex(newSeed()), nextLeaf: 0, revealed: {} };
    if (!existing) store.save(this.state);
    this.seed = hexToBytes(this.state.seed);
    this.tree = KeyTree.fromSeed(params, this.seed);
  }

  get root(): Hex {
    return bytesToHex(this.tree.root);
  }

  /** Leaves still available for ordinary operations; the reserved rotation leaf is not one of them. */
  get leavesLeft(): number {
    return Math.max(0, ROTATION_LEAF - this.state.nextLeaf);
  }

  /** The next leaf to use. Throws once only the rotation leaf remains, unless the caller is rotating. */
  nextLeaf(forRotation = false): number {
    if (forRotation) {
      if (this.state.revealed[ROTATION_LEAF] !== undefined) throw new TreeExhausted();
      return ROTATION_LEAF;
    }
    if (this.state.nextLeaf >= ROTATION_LEAF) throw new TreeExhausted();
    return this.state.nextLeaf;
  }

  /** Hashes verification will take, known before anything is revealed. */
  hashCount(digest: Hex): number {
    return verifyHashCount(this.params, hexToBytes(digest));
  }

  /** Records the leaf, then signs. Signing the same digest again repeats the same signature and reveals nothing new. */
  sign(leaf: number, digest: Hex): Hex {
    const previous = this.state.revealed[leaf];
    if (previous !== undefined && previous !== digest) throw new LeafAlreadyRevealed(leaf);
    if (previous === undefined) {
      this.state = {
        ...this.state,
        revealed: { ...this.state.revealed, [leaf]: digest },
        nextLeaf: leaf === ROTATION_LEAF ? this.state.nextLeaf : Math.max(this.state.nextLeaf, leaf + 1),
      };
      this.store.save(this.state);
    }
    const sig = wotsSign(this.params, this.seed, leaf, hexToBytes(digest));
    return bytesToHex(encodeMasterSignature(leaf, sig, this.tree.path(leaf)));
  }
}
