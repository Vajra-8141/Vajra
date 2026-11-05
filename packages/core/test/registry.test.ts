import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";
import { type LeafSnapshot, firstFreeLeaf, leafState, proves } from "../src/registry.ts";
import { KeyTree, ROTATION_LEAF, WOTS_W16, encodeMasterSignature, keccak, wotsSign } from "../src/wots.ts";

const text = (value: string) => new TextEncoder().encode(value);
const seed = keccak(text("vajra registry test"));
const digest = keccak(text("a freeze"));
const tree = KeyTree.fromSeed(WOTS_W16, seed);
const root = bytesToHex(tree.root);
const blob = (leaf: number, over = digest) => bytesToHex(encodeMasterSignature(leaf, wotsSign(WOTS_W16, seed, leaf, over), tree.path(leaf)));

const me = bytesToHex(keccak(text("this copy of the key")));
const them = bytesToHex(keccak(text("another copy of the key")));

const snapshot = (leavesUsed: number[], leavesReserved: { leaf: number; holder: `0x${string}` }[] = []) =>
  ({
    uses: leavesUsed.map((leaf) => ({ leaf })),
    reservations: leavesReserved,
    rejected: 0,
    ignored: 0,
    complete: true,
    block: 0n,
  }) as unknown as LeafSnapshot;

describe("a usage record proves itself", () => {
  const record = { root, leaf: 7, digest: bytesToHex(digest), signature: blob(7) };

  it("accepts a real signature", () => {
    expect(proves(record)).toBe(true);
  });

  it("refuses a forged signature, which is what a thief would write to block an escape", () => {
    expect(proves({ ...record, signature: `0x07${"ab".repeat(2336)}` })).toBe(false);
  });

  it("refuses a real signature claiming to be another leaf", () => {
    expect(proves({ ...record, leaf: 8 })).toBe(false);
  });

  it("refuses a real signature under another root", () => {
    expect(proves({ ...record, root: bytesToHex(keccak(text("someone else's tree"))) })).toBe(false);
  });

  it("refuses a real signature presented with another digest", () => {
    expect(proves({ ...record, digest: bytesToHex(keccak(digest)) })).toBe(false);
  });

  it("refuses a signature that is too short, without throwing", () => {
    expect(proves({ ...record, signature: "0x07" })).toBe(false);
  });

  it("refuses a row that is not even hex, without throwing: one bad row must not silence the registry", () => {
    expect(proves({ ...record, signature: "0xzz" })).toBe(false);
    expect(proves({ ...record, digest: "0x12" })).toBe(false);
  });
});

describe("choosing a leaf", () => {
  it("takes the leaf it was going to use when nothing is known against it", () => {
    expect(firstFreeLeaf(snapshot([]), 4, me)).toBe(4);
  });

  it("passes a leaf another copy has spent, which is the whole point", () => {
    expect(leafState(snapshot([4]), 4, me)).toBe("used");
    expect(firstFreeLeaf(snapshot([4, 5]), 4, me)).toBe(6);
  });

  it("passes a leaf another copy has reserved", () => {
    expect(leafState(snapshot([], [{ leaf: 4, holder: them }]), 4, me)).toBe("reserved");
    expect(firstFreeLeaf(snapshot([], [{ leaf: 4, holder: them }]), 4, me)).toBe(5);
  });

  it("is not stopped by its own reservation, which a retry leaves behind", () => {
    expect(leafState(snapshot([], [{ leaf: 4, holder: me }]), 4, me)).toBe("free");
  });

  it("falls back to a reserved leaf rather than refuse: a reservation can cost a leaf, never an operation", () => {
    const everything = Array.from({ length: ROTATION_LEAF }, (_, leaf) => ({ leaf, holder: them }));
    expect(firstFreeLeaf(snapshot([], everything), 0, me)).toBe(0);
  });

  it("never falls back to a spent leaf", () => {
    const everything = Array.from({ length: ROTATION_LEAF }, (_, leaf) => leaf);
    expect(firstFreeLeaf(snapshot(everything), 0, me)).toBeNull();
  });

  it("never offers the leaf kept for rotation", () => {
    expect(firstFreeLeaf(snapshot([]), ROTATION_LEAF, me)).toBeNull();
  });
});
