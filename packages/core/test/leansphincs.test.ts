import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { LEAN_SPHINCS_S_BYTES, coverBits, keccakCalls, leanSphincsKeygen, leanSphincsPublicKey, leanSphincsSign } from "../src/leansphincs.ts";

/** Upstream's vectors, from its own Rust signer and confirmed by its Python one. This signer was written from the spec, and read neither. */
const { vectors } = JSON.parse(readFileSync(new URL("../../../contracts/test/vectors/leansphincs-s-kat.json", import.meta.url), "utf8")) as {
  vectors: { label: string; seed: `0x${string}`; b: number; message: `0x${string}`; pkSeed: `0x${string}`; pkRoot: `0x${string}`; sig: `0x${string}` }[];
};

describe("leanSphincs-S", () => {
  for (const v of vectors) {
    it(`matches upstream byte for byte: ${v.label}`, { timeout: 120_000 }, () => {
      const key = leanSphincsKeygen(hexToBytes(v.seed), v.b);
      expect(bytesToHex(key.P)).toBe(v.pkSeed.slice(0, 34));
      expect(bytesToHex(key.root)).toBe(v.pkRoot.slice(0, 34));
      const sig = leanSphincsSign(key, hexToBytes(v.message));
      expect(sig.length).toBe(LEAN_SPHINCS_S_BYTES);
      expect(bytesToHex(sig)).toBe(v.sig);
    });
  }

  it("costs what section 14 says to generate, at any b", { timeout: 60_000 }, () => {
    const before = keccakCalls();
    leanSphincsKeygen(new Uint8Array(32).fill(7), 8);
    expect(keccakCalls() - before).toBe(2 ** 8 * 226 + 2 * (26 - 8));
  });

  it("gives the same bytes for the same message, and keeps no state", { timeout: 60_000 }, () => {
    const seed = new Uint8Array(32).fill(9);
    const key = leanSphincsKeygen(seed, 8);
    const message = new Uint8Array(32).fill(3);
    const first = leanSphincsSign(key, message);
    leanSphincsSign(key, new Uint8Array(32).fill(4));
    expect(bytesToHex(leanSphincsSign(leanSphincsKeygen(seed, 8), message))).toBe(bytesToHex(first));
  });

  it("puts the root first in the public word", () => {
    const key = leanSphincsKeygen(new Uint8Array(32).fill(1), 3);
    expect(bytesToHex(leanSphincsPublicKey(key))).toBe(`0x${bytesToHex(key.root).slice(2)}${bytesToHex(key.P).slice(2)}`);
  });

  it("reproduces upstream's cover estimate: 127 bits at 43,715 signatures on the Light tier", () => {
    expect(coverBits(43_715)).toBeCloseTo(127, 1);
  });
});
