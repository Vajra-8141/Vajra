/**
 * Winternitz one-time signatures over keccak256, with a Merkle tree of one-time keys.
 *
 * This is the reference implementation: `contracts/src/Wots.sol` is tested against vectors generated here, and the
 * master-key signer uses it directly. `w` is a parameter because the Winternitz tradeoff is a real design choice
 * (signature size against verification gas), and the measured table in docs/GAS.md is produced by varying it.
 *
 * Demo-grade, as the spec says: plain keccak chains with no per-position tweak, so multi-target attacks get a
 * ~19-bit discount that WOTS+/XMSS tweaked hashing would remove. Production uses LMS/XMSS or SPHINCS+.
 */
import { keccak_256 } from "@noble/hashes/sha3";

export type Bytes = Uint8Array;

export interface WotsParams {
  /** Bits per digit. */
  readonly logW: 2 | 4 | 8;
  /** Digit base; each chain has `w - 1` hash steps. */
  readonly w: number;
  /** Digits of the 256-bit message. */
  readonly len1: number;
  /** Digits of the checksum. */
  readonly len2: number;
  /** `len1 + len2`: chains, and 32-byte words in a signature. */
  readonly chains: number;
}

function params(logW: 2 | 4 | 8, len2: number): WotsParams {
  const w = 1 << logW;
  const len1 = 256 / logW;
  return Object.freeze({ logW, w, len1, len2, chains: len1 + len2 });
}

/** Smallest digit count that can hold the largest possible checksum, `len1 * (w - 1)`. */
export function minChecksumDigits(logW: number): number {
  const w = 2 ** logW;
  const maxChecksum = (256 / logW) * (w - 1);
  let digits = 0;
  for (let v = maxChecksum; v > 0; v = Math.floor(v / w)) digits++;
  return digits;
}

export const WOTS_W4 = params(2, 5);
export const WOTS_W16 = params(4, 3);
/** As specified: 32 + 3 chains, a 1,120-byte signature. Two checksum digits would suffice; see docs/GAS.md. */
export const WOTS_W256 = params(8, 3);

export const TREE_DEPTH = 6;
export const TREE_LEAVES = 1 << TREE_DEPTH;
/** Spec §5: the last leaf is reserved for rotating to a new tree. */
export const ROTATION_LEAF = TREE_LEAVES - 1;

export function keccak(...parts: Bytes[]): Bytes {
  if (parts.length === 1) return keccak_256(parts[0]!);
  const h = keccak_256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

function u32(n: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/** The digit of `digest` at `index`, most significant first. */
function messageDigit(digest: Bytes, index: number, logW: number): number {
  const bit = index * logW;
  const byte = digest[bit >> 3]!;
  const shift = 8 - logW - (bit & 7);
  return (byte >> shift) & ((1 << logW) - 1);
}

/** Message digits followed by checksum digits: how far along its chain each signature element sits. */
export function digits(p: WotsParams, digest: Bytes): number[] {
  if (digest.length !== 32) throw new Error("WOTS digest must be 32 bytes");
  const out: number[] = [];
  let checksum = 0;
  for (let i = 0; i < p.len1; i++) {
    const d = messageDigit(digest, i, p.logW);
    checksum += p.w - 1 - d;
    out.push(d);
  }
  for (let i = p.len2 - 1; i >= 0; i--) out.push(Math.floor(checksum / 2 ** (i * p.logW)) % p.w);
  return out;
}

function advance(value: Bytes, steps: number): Bytes {
  let h = value;
  for (let i = 0; i < steps; i++) h = keccak_256(h);
  return h;
}

/** Spec §5: `keccak(seed ‖ leafIndex ‖ chainIndex)`, with both indices as big-endian uint32. */
export function chainSeed(seed: Bytes, leaf: number, chain: number): Bytes {
  return keccak(seed, u32(leaf), u32(chain));
}

/** The leaf's public key: keccak of every chain's top. */
export function leafPublicKey(p: WotsParams, seed: Bytes, leaf: number): Bytes {
  const tops = new Uint8Array(p.chains * 32);
  for (let c = 0; c < p.chains; c++) tops.set(advance(chainSeed(seed, leaf, c), p.w - 1), c * 32);
  return keccak(tops);
}

/** Reveals each chain at the depth of its digit. Signing two digests with one leaf leaks the key: see `signer.ts`. */
export function wotsSign(p: WotsParams, seed: Bytes, leaf: number, digest: Bytes): Bytes {
  const ds = digits(p, digest);
  const sig = new Uint8Array(p.chains * 32);
  ds.forEach((d, c) => sig.set(advance(chainSeed(seed, leaf, c), d), c * 32));
  return sig;
}

/** Carries every chain to its top and hashes the tops. Equal to the leaf public key exactly when the signature is valid. */
export function wotsRecoverLeaf(p: WotsParams, digest: Bytes, sig: Bytes): Bytes {
  if (sig.length !== p.chains * 32) throw new Error(`WOTS signature must be ${p.chains * 32} bytes`);
  const tops = new Uint8Array(sig.length);
  digits(p, digest).forEach((d, c) => tops.set(advance(sig.subarray(c * 32, c * 32 + 32), p.w - 1 - d), c * 32));
  return keccak(tops);
}

/** Hashes needed to verify a signature over `digest`; the term that dominates validation gas. */
export function verifyHashCount(p: WotsParams, digest: Bytes): number {
  return digits(p, digest).reduce((sum, d) => sum + (p.w - 1 - d), 0);
}

/** A complete Merkle tree over the leaf public keys. `levels[0]` holds the leaves, the last level the root. */
export class KeyTree {
  readonly levels: Bytes[][];

  constructor(leaves: Bytes[]) {
    if (leaves.length !== TREE_LEAVES) throw new Error(`a key tree has ${TREE_LEAVES} leaves`);
    this.levels = [leaves];
    while (this.levels.at(-1)!.length > 1) {
      const level = this.levels.at(-1)!;
      const next: Bytes[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(keccak(level[i]!, level[i + 1]!));
      this.levels.push(next);
    }
  }

  static fromSeed(p: WotsParams, seed: Bytes): KeyTree {
    return new KeyTree(Array.from({ length: TREE_LEAVES }, (_, leaf) => leafPublicKey(p, seed, leaf)));
  }

  get root(): Bytes {
    return this.levels.at(-1)![0]!;
  }

  /** Sibling hashes from the leaf upwards. */
  path(leaf: number): Bytes[] {
    const path: Bytes[] = [];
    let index = leaf;
    for (let d = 0; d < TREE_DEPTH; d++) {
      path.push(this.levels[d]![index ^ 1]!);
      index >>= 1;
    }
    return path;
  }
}

export function merkleRoot(leafKey: Bytes, leaf: number, path: Bytes[]): Bytes {
  let node = leafKey;
  let index = leaf;
  for (const sibling of path) {
    node = index & 1 ? keccak(sibling, node) : keccak(node, sibling);
    index >>= 1;
  }
  return node;
}

/** What rides in the transaction's ARBITRARY signature entry: `leafIndex (1 byte) ‖ WOTS signature ‖ Merkle path`. */
export function encodeMasterSignature(leaf: number, sig: Bytes, path: Bytes[]): Bytes {
  const out = new Uint8Array(1 + sig.length + path.length * 32);
  out[0] = leaf;
  out.set(sig, 1);
  path.forEach((node, i) => out.set(node, 1 + sig.length + i * 32));
  return out;
}

/** True exactly when a blob is a valid signature over `digest` under `root`: what the account will check, done first. */
export function verifyMasterSignature(p: WotsParams, digest: Bytes, blob: Bytes, root: Bytes): boolean {
  try {
    const { leaf, sig, path } = decodeMasterSignature(p, blob);
    const recovered = merkleRoot(wotsRecoverLeaf(p, digest, sig), leaf, path);
    return recovered.length === root.length && recovered.every((byte, i) => byte === root[i]);
  } catch {
    return false;
  }
}

export function decodeMasterSignature(p: WotsParams, blob: Bytes): { leaf: number; sig: Bytes; path: Bytes[] } {
  const sigLength = p.chains * 32;
  if (blob.length !== 1 + sigLength + TREE_DEPTH * 32) throw new Error("malformed master signature");
  const path = Array.from({ length: TREE_DEPTH }, (_, i) => blob.subarray(1 + sigLength + i * 32, 1 + sigLength + (i + 1) * 32));
  return { leaf: blob[0]!, sig: blob.subarray(1, 1 + sigLength), path };
}
