/**
 * Stealth payments: ERC-8441 for receiving, and a VAJRA account for spending.
 *
 * The first half of this file is ERC-8441 schemeId 3 as written, checked against the ERC's conformance vectors. The
 * last section is the delta, which docs/STEALTH.md explains: ERC-8441 ends in a plain EOA, and VAJRA ends in an account
 * that needs two signatures, because a hash-based key cannot be derived the way ERC-8441 derives an elliptic-curve one.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { type Address, bytesToHex, getAddress, hexToBytes } from "viem";
import { type Bytes, keccak } from "./wots.ts";

const N = secp256k1.CURVE.n;
const Point = secp256k1.ProjectivePoint;
const text = (s: string) => new TextEncoder().encode(s);

const DS_COMBINE = text("pq-stealth/hybrid-payment/v1");
const DS_OFFSET = text("pq-stealth/offset/v1");
const DS_VIEW_TAG = text("pq-stealth/view-tag/v1");

export const STEALTH_SCHEME_ID = 3;
export const META_LENGTH = 1250;
export const EPHEMERAL_LENGTH = 1121;

function concatBytes(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const toBig = (b: Bytes) => BigInt(bytesToHex(b));
const toBytes32 = (n: bigint) => hexToBytes(`0x${n.toString(16).padStart(64, "0")}`);
const equal = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i]);

export const isValidScalar = (b: Bytes) => b.length === 32 && toBig(b) > 0n && toBig(b) < N;

/** ERC-8441 §1: `base` in range, or failure. Never reduced mod n: that would allow an offset of zero. */
export function offsetFromBase(base: Bytes): bigint {
  const value = toBig(base);
  if (value === 0n || value >= N) throw new Error("H(ss) out of range");
  return value;
}

export const offsetOf = (ss: Bytes): bigint => offsetFromBase(sha256(concatBytes(DS_OFFSET, ss)));

export const viewTag = (ss: Bytes): number => sha256(concatBytes(DS_VIEW_TAG, ss))[0]!;

export const ecdhX = (scalar: Bytes, point: Bytes): Bytes => secp256k1.getSharedSecret(scalar, point, true).slice(1);

export function hybridCombine(p: { ssEc: Bytes; ssPq: Bytes; epk: Bytes; ct: Bytes; viewingPk: Bytes; ek: Bytes }): Bytes {
  return sha3_256(concatBytes(DS_COMBINE, p.ssEc, p.ssPq, p.epk, p.ct, p.viewingPk, p.ek));
}

export interface StealthKeys {
  /** Never leaves the owner. */
  spendingSk: Bytes;
  spendingPk: Bytes;
  viewingEc: Bytes;
  viewingPk: Bytes;
  /** ML-KEM seed `d ‖ z`, the rest of the tracking key. */
  kemSeed: Bytes;
  ek: Bytes;
  dk: Bytes;
  /** Published through ERC-6538. */
  meta: Bytes;
  /** `viewing_ec ‖ d ‖ z`. May go to a scanner; cannot spend. */
  tracking: Bytes;
}

/** ERC-8441 §2.1. Deterministic in the 128-byte seed. */
export function stealthKeygen(seed: Bytes): StealthKeys {
  if (seed.length !== 128) throw new Error("keygen seed must be 128 bytes");
  const spendingSk = seed.slice(0, 32);
  const viewingEc = seed.slice(32, 64);
  const kemSeed = seed.slice(64, 128);
  if (!isValidScalar(spendingSk) || !isValidScalar(viewingEc)) throw new Error("seed is not a valid scalar");
  if (equal(spendingSk, viewingEc) || equal(spendingSk, kemSeed.slice(0, 32)) || equal(spendingSk, kemSeed.slice(32))) {
    throw new Error("spending_seed must differ from every other component");
  }
  const { publicKey: ek, secretKey: dk } = ml_kem768.keygen(kemSeed);
  const spendingPk = secp256k1.getPublicKey(spendingSk, true);
  const viewingPk = secp256k1.getPublicKey(viewingEc, true);
  return {
    spendingSk,
    spendingPk,
    viewingEc,
    viewingPk,
    kemSeed,
    ek,
    dk,
    meta: concatBytes(spendingPk, viewingPk, ek),
    tracking: concatBytes(viewingEc, kemSeed),
  };
}

function compressedPoint(bytes: Bytes): Bytes {
  if (bytes.length !== 33 || (bytes[0] !== 2 && bytes[0] !== 3)) throw new Error("not a compressed point");
  Point.fromHex(bytes);
  return bytes;
}

export interface MetaAddress {
  spendingPk: Bytes;
  viewingPk: Bytes;
  ek: Bytes;
}

/** ERC-8441 §2.2. */
export function decodeMeta(meta: Bytes): MetaAddress {
  if (meta.length !== META_LENGTH) throw new Error("a meta-address is 1250 bytes");
  return { spendingPk: compressedPoint(meta.slice(0, 33)), viewingPk: compressedPoint(meta.slice(33, 66)), ek: meta.slice(66) };
}

export function stealthPublicKey(spendingPk: Bytes, ss: Bytes): Bytes {
  return Point.fromHex(spendingPk).add(Point.BASE.multiply(offsetOf(ss))).toRawBytes(true);
}

export function stealthSecretKey(spendingSk: Bytes, ss: Bytes): Bytes {
  return toBytes32((toBig(spendingSk) + offsetOf(ss)) % N);
}

/** `keccak256(uncompressed(pk)[1..65])[12..32]`, as an EOA address. */
export function addressOfPublicKey(pk: Bytes): Address {
  const uncompressed = Point.fromHex(pk).toRawBytes(false);
  return getAddress(bytesToHex(keccak_256(uncompressed.slice(1)).slice(12)));
}

export interface Payment {
  ss: Bytes;
  /** `epk ‖ ct`, 1,121 bytes: the `ephemeralPubKey` of the announcement. */
  ephemeral: Bytes;
  viewTag: number;
}

/** ERC-8441 §2.4. Randomness is injectable only so tests can pin it. */
export function createPayment(meta: MetaAddress, randomness?: { esk: Bytes; m: Bytes }): Payment {
  const esk = randomness?.esk ?? secp256k1.utils.randomPrivateKey();
  const epk = secp256k1.getPublicKey(esk, true);
  const { cipherText: ct, sharedSecret: ssPq } = ml_kem768.encapsulate(meta.ek, randomness?.m);
  const ss = hybridCombine({ ssEc: ecdhX(esk, meta.viewingPk), ssPq, epk, ct, viewingPk: meta.viewingPk, ek: meta.ek });
  offsetOf(ss);
  return { ss, ephemeral: concatBytes(epk, ct), viewTag: viewTag(ss) };
}

/**
 * ERC-8441 §2.5, up to the address comparison, which the caller makes because what an address is depends on the scheme.
 * Returns `ss` when the view tag matches, and null for anything to skip. A malformed announcement is a skip, never an
 * error: `announce` is permissionless, so a scanner has to survive whatever is posted there.
 */
export function openAnnouncement(keys: Pick<StealthKeys, "viewingEc" | "viewingPk" | "ek" | "dk">, ephemeral: Bytes, metadata: Bytes): Bytes | null {
  if (ephemeral.length !== EPHEMERAL_LENGTH || metadata.length === 0) return null;
  const epk = ephemeral.slice(0, 33);
  const ct = ephemeral.slice(33);
  let ssEc: Bytes;
  try {
    ssEc = ecdhX(keys.viewingEc, compressedPoint(epk));
  } catch {
    return null;
  }
  const ssPq = ml_kem768.decapsulate(ct, keys.dk);
  const ss = hybridCombine({ ssEc, ssPq, epk, ct, viewingPk: keys.viewingPk, ek: keys.ek });
  if (viewTag(ss) !== metadata[0]) return null;
  try {
    offsetOf(ss);
  } catch {
    return null;
  }
  return ss;
}

// ---------------------------------------------------------------------------------------------- the VAJRA delta ----

/** Spec §8.2. Known to the sender, which is exactly why this seed alone must never be enough to spend. */
export const stealthWotsSeed = (ss: Bytes): Bytes => keccak(ss, text("vajra-stealth-v1"));

/** The account's second signer: ERC-8441's own stealth EOA, whose key the sender cannot compute. */
export const stealthCoSigner = (spendingPk: Bytes, ss: Bytes): Address => addressOfPublicKey(stealthPublicKey(spendingPk, ss));

