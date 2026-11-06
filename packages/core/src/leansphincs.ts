/**
 * leanSphincs-S over keccak256, written from nconsigny/SPHINCs- at 4c76aaf, docs/leanSphincs-S-keccak.md. Section numbers are that file's.
 * `test/leansphincs.test.ts` holds this to that repository's known-answer vectors, byte for byte.
 *
 * A hash key with no leaves to run out of: signing twice is safe, so nothing has to remember what was revealed. It is here for
 * `vajra sphincs-bench`. Research parameters, not audited, and the key lives in memory.
 *
 * One seed is one key: never use a seed with two values of `b` (section 14). A signature under one could be turned into a
 * signature under the other, with no secret.
 */
import { keccak_256 } from "@noble/hashes/sha3";

type Bytes = Uint8Array;

export const LEAN_SPHINCS_S_BYTES = 4164;
/** The Light tier of section 14: a kept subtree of 2^13 one-time keys, and a 16 KiB cache of level 3. */
export const LIGHT_B = 13;
/** What upstream rates the Light tier for. An estimate, not a proof, and nothing enforces it: not the signer, the key or the verifier. */
export const LIGHT_RATED_SIGNATURES = 20_000;

const N = 16;
const H = 26;
const FORS_TREES = 13;
const FORS_HEIGHT = 12;
const CHAINS = 64;
const TARGET_SUM = 128;
/** Light's plan, for every `b` here. A signature's bytes do not depend on the plan, only the work does. */
const CACHE_LEVEL = 3;
const ZERO = new Uint8Array(N);
/** Tweak types, section 3. */
const T = { PRF: 0, CHAIN: 1, LEAF: 2, NODE: 3, ENC: 4, PARAMETER: 5, RANDOMIZER: 7, FTS_PRF: 8, FTS_LEAF: 9, FTS_NODE: 10, MSG: 12, SURROGATE: 13 } as const;

let calls = 0;
/** keccak256 calls so far in this process, to hold the run's work against section 14's table. */
export const keccakCalls = () => calls;

/** `P ‖ address(t, step, hi, lo)`, section 3, with room after it. */
function header(P: Bytes, t: number, step: number, hi: number, lo: number, room: number): Bytes {
  const input = new Uint8Array(32 + room);
  input.set(P);
  input[16] = lo & 255;
  input[17] = (lo >>> 8) & 255;
  input[18] = (lo >>> 16) & 255;
  input[19] = lo >>> 24;
  input[20] = hi & 255;
  input[21] = (hi >>> 8) & 255;
  input[22] = (hi >>> 16) & 255;
  input[23] = t | (step << 5);
  return input;
}

/** `ThFull`, section 2: all 32 bytes. `b` is the second half of a payload that comes in two. */
function thFull(P: Bytes, t: number, step: number, hi: number, lo: number, a: Bytes, b?: Bytes): Bytes {
  const input = header(P, t, step, hi, lo, a.length + (b?.length ?? 0));
  input.set(a, 32);
  if (b) input.set(b, 32 + a.length);
  calls++;
  return keccak_256(input);
}

/** `Th`, section 2: the first 16 bytes. */
const th = (P: Bytes, t: number, step: number, hi: number, lo: number, a: Bytes, b?: Bytes) => thFull(P, t, step, hi, lo, a, b).subarray(0, N);

const half = (pair: Bytes, which: number) => pair.subarray(which * N, (which + 1) * N);

/** The WOTS leaf at `e`: 32 secret pairs, 192 chain steps and the leaf hash. Section 6. */
function wotsLeaf(P: Bytes, S: Bytes, e: number): Bytes {
  const ends = new Uint8Array(CHAINS * N);
  for (let t = 0; t < CHAINS / 2; t++) {
    const pair = thFull(P, T.PRF, 0, t, e, S);
    for (let side = 0; side < 2; side++) {
      const i = 2 * t + side;
      let x = half(pair, side);
      for (let to = 1; to <= 3; to++) x = th(P, T.CHAIN, to - 1, i, e, x);
      ends.set(x, i * N);
    }
  }
  return th(P, T.LEAF, 0, 0, e, ends);
}

/** Hashes one level of the key tree into the next, `first` being the index of its leftmost node there. Section 8. */
function up(P: Bytes, level: Bytes[], height: number, first: number): Bytes[] {
  const next: Bytes[] = [];
  for (let i = 0; i < level.length; i += 2) next.push(th(P, T.NODE, 0, height, first + i / 2, level[i]!, level[i + 1]!));
  return next;
}

/** Every level of the block of 2^CACHE_LEVEL leaves under node `j` of the cached level, leaves first. */
function block(P: Bytes, S: Bytes, j: number): Bytes[][] {
  const first = j * 2 ** CACHE_LEVEL;
  const leaves: Bytes[] = [];
  for (let e = first; e < first + 2 ** CACHE_LEVEL; e++) leaves.push(wotsLeaf(P, S, e));
  const levels = [leaves];
  for (let height = 1; height <= CACHE_LEVEL; height++) levels.push(up(P, levels[height - 1]!, height, first >>> height));
  return levels;
}

export interface LeanSphincsKey {
  seed: Bytes;
  b: number;
  P: Bytes;
  root: Bytes;
  /** Which subtree of 2^b leaves this key kept. */
  subtree: number;
  surrogates: Bytes[];
  /** The kept subtree's nodes at CACHE_LEVEL. They are public: signatures reveal them. */
  cache: Bytes[];
}

/** Section 9. Costs `2^b * 226 + 2 * (26 - b)` keccak256 calls. */
export function leanSphincsKeygen(seed: Bytes, b: number = LIGHT_B): LeanSphincsKey {
  if (seed.length !== 32) throw new Error("a seed is 32 bytes");
  if (b < CACHE_LEVEL || b >= H) throw new Error(`b must be from ${CACHE_LEVEL} to ${H - 1} here`);
  const P = th(ZERO, T.PARAMETER, 0, 0, 0, seed);
  const subtree = new DataView(P.buffer, P.byteOffset).getUint32(0, true) & (2 ** (H - b) - 1);
  const firstCached = subtree * 2 ** (b - CACHE_LEVEL);
  const cache: Bytes[] = [];
  for (let j = 0; j < 2 ** (b - CACHE_LEVEL); j++) cache.push(block(P, seed, firstCached + j)[CACHE_LEVEL]![0]!);
  let level = cache;
  for (let height = CACHE_LEVEL + 1; height <= b; height++) level = up(P, level, height, subtree * 2 ** (b - height));
  let root = level[0]!;
  const surrogates: Bytes[] = [];
  for (let height = b; height < H; height++) {
    const sibling = th(P, T.SURROGATE, 0, height, 0, seed);
    surrogates.push(sibling);
    const side = (subtree >>> (height - b)) & 1;
    root = th(P, T.NODE, 0, height + 1, subtree >>> (height - b + 1), side ? sibling : root, side ? root : sibling);
  }
  return { seed, b, P, root, subtree, surrogates, cache };
}

/** The one word an account keeps: `root ‖ P`. The verifier takes it apart as `P ‖ 0^16` and `root ‖ 0^16`. */
export function leanSphincsPublicKey(key: LeanSphincsKey): Bytes {
  const word = new Uint8Array(32);
  word.set(key.root);
  word.set(key.P, N);
  return word;
}

/** The digit sum of each codeword byte, four digits of two bits each. */
const DIGIT_SUM = Uint8Array.from({ length: 256 }, (_, byte) => (byte & 3) + ((byte >> 2) & 3) + ((byte >> 4) & 3) + (byte >> 6));

/** Opens one tree's leaf `u`, and writes the 16-byte secret and the 12 path nodes where section 11 puts them. Returns the tree's two tops. */
function forsTree(P: Bytes, S: Bytes, idx: number, tree: number, u: number, sig: Bytes): [Bytes, Bytes] {
  const pos = (level: number, j: number) => tree + 32 * level + 512 * j;
  const offset = 16 + 208 * tree;
  let level: Bytes[] = new Array(2 ** FORS_HEIGHT);
  for (let t = 0; t < 2 ** (FORS_HEIGHT - 1); t++) {
    const pair = thFull(P, T.FTS_PRF, 0, pos(0, t), idx, S);
    for (let side = 0; side < 2; side++) {
      const j = 2 * t + side;
      const secret = half(pair, side);
      if (j === u) sig.set(secret, offset);
      level[j] = th(P, T.FTS_LEAF, 0, pos(0, j), idx, secret);
    }
  }
  for (let l = 0; l < FORS_HEIGHT - 1; l++) {
    sig.set(level[(u >>> l) ^ 1]!, offset + N + N * l);
    const next: Bytes[] = new Array(level.length / 2);
    for (let j = 0; j < next.length; j++) next[j] = th(P, T.FTS_NODE, 0, pos(l + 1, j), idx, level[2 * j]!, level[2 * j + 1]!);
    level = next;
  }
  sig.set(level[(u >>> (FORS_HEIGHT - 1)) ^ 1]!, offset + N + N * (FORS_HEIGHT - 1));
  return [level[0]!, level[1]!];
}

/** Section 10. The same message gives the same bytes, and every distinct message counts against the key's lifetime. */
export function leanSphincsSign(key: LeanSphincsKey, message: Bytes): Bytes {
  if (message.length !== 32) throw new Error("a message is 32 bytes");
  const { P, seed: S, b, subtree } = key;
  const rho = Uint8Array.from(th(P, T.RANDOMIZER, 0, 0, 0, S, message));

  // The least randomizer whose leaf is in the kept subtree.
  let digest: Bytes;
  let idx: number;
  for (;;) {
    digest = thFull(P, T.MSG, 0, 0, 0, message, rho);
    idx = digest[24]! | (digest[25]! << 8) | (digest[26]! << 16) | ((digest[27]! & 3) << 24);
    if (idx >>> b === subtree) break;
    for (let i = 0; i < N && ++rho[i]! === 256; i++) rho[i] = 0;
  }

  const sig = new Uint8Array(LEAN_SPHINCS_S_BYTES);
  sig.set(rho);

  const words = new DataView(digest.buffer, digest.byteOffset);
  const tops = new Uint8Array(FORS_TREES * 2 * N);
  for (let tree = 0; tree < FORS_TREES; tree++) {
    const u = Number((words.getBigUint64(8 * Math.floor(tree / 5), true) >> BigInt(FORS_HEIGHT * (tree % 5))) & 0xfffn);
    const [left, right] = forsTree(P, S, idx, tree, u, sig);
    tops.set(left, tree * 2 * N);
    tops.set(right, (tree * 2 + 1) * N);
  }

  // The counter falls in the last block of the encoding's input, so each try costs one permutation from this midstate.
  const fixed = header(P, T.ENC, 0, 0, idx, tops.length);
  fixed.set(tops, 32);
  const midstate = keccak_256.create().update(fixed);
  const counter = new Uint8Array(4);
  const counterView = new DataView(counter.buffer);
  let codeword: Bytes;
  for (let c = 0; ; c++) {
    counterView.setUint32(0, c, true);
    calls++;
    codeword = midstate.clone().update(counter).digest();
    let sum = 0;
    for (let i = 0; i < N; i++) sum += DIGIT_SUM[codeword[i]!]!;
    if (sum === TARGET_SUM) break;
  }
  sig.set(counter, 2720);

  for (let t = 0; t < CHAINS / 2; t++) {
    const pair = thFull(P, T.PRF, 0, t, idx, S);
    for (let side = 0; side < 2; side++) {
      const i = 2 * t + side;
      const digit = (codeword[i >>> 2]! >>> (2 * (i & 3))) & 3;
      let x = half(pair, side);
      for (let to = 1; to <= digit; to++) x = th(P, T.CHAIN, to - 1, i, idx, x);
      sig.set(x, 2724 + N * i);
    }
  }

  // The auth path: the signed leaf's block, then the cache hashed up to the kept subtree's root, then the surrogates. Section 14.
  const inBlock = idx & (2 ** CACHE_LEVEL - 1);
  const levels = block(P, S, idx >>> CACHE_LEVEL);
  for (let l = 0; l < CACHE_LEVEL; l++) sig.set(levels[l]![(inBlock >>> l) ^ 1]!, 3748 + N * l);
  let at = (idx >>> CACHE_LEVEL) - subtree * 2 ** (b - CACHE_LEVEL);
  let level = key.cache;
  for (let l = CACHE_LEVEL; l < b; l++) {
    sig.set(level[at ^ 1]!, 3748 + N * l);
    level = up(P, level, l + 1, subtree * 2 ** (b - l - 1));
    at >>>= 1;
  }
  key.surrogates.forEach((sibling, i) => sig.set(sibling, 3748 + N * (b + i)));
  return sig;
}

/**
 * Upstream's bound on how a key wears with use, in bits, after `signatures`: the largest N with
 * `2^127 * 2^(b-26) * E[r ~ Poisson(N / 2^b)] (1 - (1 - 2^-12)^r)^13 <= 1` is what section 14 calls the cover estimate. An estimate, not a proof.
 */
export function coverBits(signatures: number, b: number = LIGHT_B): number {
  const lambda = signatures / 2 ** b;
  const miss = 1 - 2 ** -FORS_HEIGHT;
  let logPoisson = -lambda;
  let expectation = 0;
  for (let r = 1; r < 20_000; r++) {
    logPoisson += Math.log(lambda / r);
    expectation += Math.exp(logPoisson + FORS_TREES * Math.log(1 - miss ** r));
  }
  return H - b - Math.log2(expectation);
}
