import { describe, expect, it } from "vitest";
import { type Hex, keccak256, toHex } from "viem";
import { ChainStateUnknown, LeafAlreadyRevealed, MasterSigner, TreeExhausted, memoryStore } from "../src/signer.ts";
import { ROTATION_LEAF, WOTS_W16 } from "../src/wots.ts";

const seed = () => new Uint8Array(32).fill(7);
const digest = (s: string): Hex => keccak256(toHex(s));

describe("MasterSigner", () => {
  it("refuses a second digest on a revealed leaf", () => {
    const signer = new MasterSigner(WOTS_W16, memoryStore(), seed);
    signer.sign(0, digest("first"));
    expect(() => signer.sign(0, digest("second"))).toThrow(LeafAlreadyRevealed);
  });

  it("repeats the identical signature for the same digest, so a rebroadcast is safe", () => {
    const signer = new MasterSigner(WOTS_W16, memoryStore(), seed);
    expect(signer.sign(0, digest("first"))).toBe(signer.sign(0, digest("first")));
  });

  it("remembers revealed leaves across a restart", () => {
    const store = memoryStore();
    new MasterSigner(WOTS_W16, store, seed).sign(0, digest("first"));
    const restarted = new MasterSigner(WOTS_W16, store, () => {
      throw new Error("must reuse the stored seed");
    });
    expect(() => restarted.sign(0, digest("second"))).toThrow(LeafAlreadyRevealed);
    expect(restarted.nextLeaf()).toBe(1);
  });

  /** The write-ahead property: a crash between saving and returning loses a leaf, never reveals one twice. */
  it("records the leaf before the signature exists", () => {
    const store = memoryStore();
    const signer = new MasterSigner(WOTS_W16, store, seed);
    const saves: number[] = [];
    const save = store.save;
    store.save = (s) => {
      saves.push(Object.keys(s.revealed).length);
      save(s);
    };
    signer.sign(0, digest("first"));
    expect(saves).toEqual([1]);
  });

  it("does not hand out a skipped leaf after a later one was used", () => {
    const signer = new MasterSigner(WOTS_W16, memoryStore(), seed);
    signer.sign(5, digest("five"));
    expect(signer.nextLeaf()).toBe(6);
  });

  it("keeps the last leaf for rotation and then refuses", () => {
    const signer = new MasterSigner(WOTS_W16, memoryStore(), seed);
    for (let leaf = 0; leaf < ROTATION_LEAF; leaf++) signer.sign(leaf, digest(`op ${leaf}`));
    expect(signer.leavesLeft).toBe(0);
    expect(() => signer.nextLeaf()).toThrow(TreeExhausted);
    expect(signer.nextLeaf(true)).toBe(ROTATION_LEAF);
    signer.sign(ROTATION_LEAF, digest("rotate"));
    expect(() => signer.nextLeaf(true)).toThrow(TreeExhausted);
  });

  it("names the mismatch when the chain disagrees", () => {
    expect(new ChainStateUnknown("0x01", "0x02").message).toContain("chain state unknown");
  });
});
