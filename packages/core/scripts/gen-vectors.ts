/** Writes contracts/test/vectors/wots.json: signatures from the TypeScript reference for the Solidity verifier to check. */
import { writeFileSync } from "node:fs";
import { KeyTree, WOTS_W16, WOTS_W256, WOTS_W4, keccak, leafPublicKey, verifyHashCount, wotsSign, type WotsParams } from "../src/wots.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const text = (s: string) => new TextEncoder().encode(s);
const seed = keccak(text("vajra test vectors"));

function vector(p: WotsParams, leaf: number, label: string) {
  const tree = KeyTree.fromSeed(p, seed);
  const digest = keccak(text(label));
  const path = new Uint8Array(tree.path(leaf).flatMap((n) => [...n]));
  return {
    logW: p.logW,
    len2: p.len2,
    leaf,
    digest: hex(digest),
    signature: hex(wotsSign(p, seed, leaf, digest)),
    path: hex(path),
    leafKey: hex(leafPublicKey(p, seed, leaf)),
    root: hex(tree.root),
    hashes: verifyHashCount(p, digest),
  };
}

const out = {
  w4: vector(WOTS_W4, 5, "vector w4"),
  w16: vector(WOTS_W16, 5, "vector w16"),
  w256: vector(WOTS_W256, 5, "vector w256"),
  w16last: vector(WOTS_W16, 63, "vector w16 last leaf"),
};
writeFileSync(new URL("../../../contracts/test/vectors/wots.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(Object.entries(out).map(([k, v]) => `${k}: ${(v.signature.length - 2) / 2} B, ${v.hashes} hashes`).join("\n"));
