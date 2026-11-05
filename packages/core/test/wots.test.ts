import { describe, expect, it } from "vitest";
import {
  KeyTree,
  ROTATION_LEAF,
  TREE_DEPTH,
  TREE_LEAVES,
  WOTS_W16,
  WOTS_W256,
  WOTS_W4,
  decodeMasterSignature,
  digits,
  encodeMasterSignature,
  keccak,
  leafPublicKey,
  merkleRoot,
  minChecksumDigits,
  verifyHashCount,
  wotsRecoverLeaf,
  wotsSign,
  type WotsParams,
} from "../src/wots.ts";

const seed = keccak(new TextEncoder().encode("vajra test seed"));
const digest = keccak(new TextEncoder().encode("a transaction"));
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe.each<[string, WotsParams]>([
  ["w=4", WOTS_W4],
  ["w=16", WOTS_W16],
  ["w=256", WOTS_W256],
])("%s", (_, p) => {
  it("has a checksum wide enough for the largest possible value", () => {
    expect(p.len2).toBeGreaterThanOrEqual(minChecksumDigits(p.logW));
    expect(digits(p, digest)).toHaveLength(p.chains);
  });

  it("a signature recovers the leaf public key", () => {
    expect(eq(wotsRecoverLeaf(p, digest, wotsSign(p, seed, 3, digest)), leafPublicKey(p, seed, 3))).toBe(true);
  });

  it("a signature does not verify for another digest", () => {
    const other = keccak(digest);
    expect(eq(wotsRecoverLeaf(p, other, wotsSign(p, seed, 3, digest)), leafPublicKey(p, seed, 3))).toBe(false);
  });

  it("a flipped signature bit does not verify", () => {
    const sig = wotsSign(p, seed, 3, digest);
    sig[40]! ^= 1;
    expect(eq(wotsRecoverLeaf(p, digest, sig), leafPublicKey(p, seed, 3))).toBe(false);
  });

  it("another leaf's key does not verify", () => {
    expect(eq(wotsRecoverLeaf(p, digest, wotsSign(p, seed, 4, digest)), leafPublicKey(p, seed, 3))).toBe(false);
  });

  /**
   * The property the checksum exists for. Raising a message digit lets a forger hash a revealed value forward, so
   * without a checksum one signature yields forgeries; with it, raising any message digit lowers a checksum digit,
   * which would need a preimage.
   */
  it("raising a message digit always lowers some checksum digit", () => {
    const low = new Uint8Array(32).fill(0x11);
    const raised = low.slice();
    raised[0] = 0x21;
    const a = digits(p, low).slice(p.len1);
    const b = digits(p, raised).slice(p.len1);
    expect(b.some((d, i) => d < a[i]!)).toBe(true);
  });

  it("counts the hashes verification performs", () => {
    const sum = digits(p, digest).reduce((s, d) => s + (p.w - 1 - d), 0);
    expect(verifyHashCount(p, digest)).toBe(sum);
  });
});

describe("digit extraction", () => {
  it("reads digits most significant first", () => {
    const d = new Uint8Array(32);
    d[0] = 0xab;
    expect(digits(WOTS_W256, d)[0]).toBe(0xab);
    expect(digits(WOTS_W16, d).slice(0, 2)).toEqual([0xa, 0xb]);
    expect(digits(WOTS_W4, d).slice(0, 4)).toEqual([2, 2, 2, 3]);
  });

  it("encodes the checksum big-endian", () => {
    const zero = new Uint8Array(32);
    // Every message digit is 0, so the checksum is at its maximum: 64 * 15 = 960 = 0x3c0.
    expect(digits(WOTS_W16, zero).slice(64)).toEqual([0x3, 0xc, 0x0]);
    // 32 * 255 = 8160 = 0x1fe0, which is why the top digit of the third w=256 checksum chain is always zero.
    expect(digits(WOTS_W256, zero).slice(32)).toEqual([0x00, 0x1f, 0xe0]);
  });
});

describe("the spec's numbers", () => {
  it("w=256 is 35 chains and a 1,120-byte signature", () => {
    expect(WOTS_W256.chains).toBe(35);
    expect(WOTS_W256.chains * 32).toBe(1120);
  });

  it("two checksum digits are enough at w=256, so the third chain carries nothing", () => {
    expect(minChecksumDigits(8)).toBe(2);
  });
});

describe("key tree", () => {
  const tree = KeyTree.fromSeed(WOTS_W16, seed);

  it("has 64 leaves and reserves the last for rotation", () => {
    expect(TREE_LEAVES).toBe(64);
    expect(ROTATION_LEAF).toBe(63);
  });

  it("every leaf's path reaches the root", () => {
    for (const leaf of [0, 1, 31, 62, 63]) {
      const key = leafPublicKey(WOTS_W16, seed, leaf);
      expect(eq(merkleRoot(key, leaf, tree.path(leaf)), tree.root)).toBe(true);
    }
  });

  it("a path presented at the wrong index does not reach the root", () => {
    const key = leafPublicKey(WOTS_W16, seed, 5);
    expect(eq(merkleRoot(key, 4, tree.path(5)), tree.root)).toBe(false);
  });
});

describe("master signature encoding", () => {
  it("round-trips", () => {
    const tree = KeyTree.fromSeed(WOTS_W16, seed);
    const sig = wotsSign(WOTS_W16, seed, 9, digest);
    const blob = encodeMasterSignature(9, sig, tree.path(9));
    expect(blob.length).toBe(1 + WOTS_W16.chains * 32 + TREE_DEPTH * 32);
    const out = decodeMasterSignature(WOTS_W16, blob);
    expect(out.leaf).toBe(9);
    expect(eq(out.sig, sig)).toBe(true);
    expect(out.path.every((n, i) => eq(n, tree.path(9)[i]!))).toBe(true);
  });
});
