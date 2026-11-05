import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { type Hex, bytesToHex, hexToBytes } from "viem";
import {
  addressOfPublicKey,
  createPayment,
  decodeMeta,
  ecdhX,
  hybridCombine,
  isValidScalar,
  offsetFromBase,
  offsetOf,
  openAnnouncement,
  stealthCoSigner,
  stealthKeygen,
  stealthPublicKey,
  stealthSecretKey,
  stealthWotsSeed,
  viewTag,
} from "../src/stealth.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const load = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`./vectors/erc8441/${name}.json`, import.meta.url), "utf8")).vectors;
const v1 = load("section-1");
const v2 = load("section-2");
const b = (hex: string) => hexToBytes(`0x${hex}` as Hex);
const h = (bytes: Uint8Array) => bytesToHex(bytes).slice(2);

describe("ERC-8441 section 1", () => {
  it("V1-01 derives the offset", () => {
    expect(offsetOf(b(v1["V1-01"].given.ss)).toString(16).padStart(64, "0")).toBe(v1["V1-01"].expect.base);
  });

  it("V1-03 rejects base = 0", () => {
    expect(() => offsetFromBase(b(v1["V1-03"].given.base))).toThrow();
  });

  it("V1-04 rejects base = n rather than reducing it", () => {
    expect(() => offsetFromBase(b(v1["V1-04"].given.base))).toThrow();
  });

  it("V1-05 accepts base = n - 1", () => {
    expect(offsetFromBase(b(v1["V1-05"].given.base)).toString(16)).toBe(v1["V1-05"].expect.offset);
  });

  it("V1-07 takes the view tag from its own digest", () => {
    expect(viewTag(b(v1["V1-07"].given.ss)).toString(16)).toBe(v1["V1-07"].expect.view_tag);
  });
});

describe("ERC-8441 section 2", () => {
  const keygenVector = v2["V3-09"];
  const keys = stealthKeygen(b(keygenVector.given.keygen_seed));

  it("V3-09 keygen is deterministic and matches the meta-address", () => {
    expect(h(keys.meta)).toBe(keygenVector.expect.meta_address);
    expect(h(keys.tracking)).toBe(keygenVector.expect.tracking);
    expect(h(keys.spendingSk)).toBe(keygenVector.expect.master);
  });

  it("V3-01 refuses a seed of any other length", () => {
    expect(() => stealthKeygen(b(v2["V3-01"].given.seeds["96"]))).toThrow();
    expect(() => stealthKeygen(b(v2["V3-01"].given.seeds["127"]))).toThrow();
    expect(() => stealthKeygen(b(v2["V3-01"].given.seeds["128"]))).not.toThrow();
  });

  it("V3-04 uses the x-coordinate alone", () => {
    const { given, expect: want } = v2["V3-04"];
    const point = given.viewing_pk_ec ?? h(keys.viewingPk);
    expect(h(ecdhX(b(given.esk), b(point)))).toBe(want.ss_ec);
  });

  it("V3-06 combines in exactly the specified order", () => {
    const p = v2["V3-06"].given.parts;
    const ss = hybridCombine({ ssEc: b(p.ss_ec), ssPq: b(p.ss_pq), epk: b(p.epk), ct: b(p.ct), viewingPk: b(p.viewing_pk_ec), ek: b(p.ek) });
    expect(h(ss)).toBe(v2["V3-06"].expect.ss);
  });

  it("V3-13 derives the address", () => {
    expect(addressOfPublicKey(b(v2["V3-13"].given.stealth_pk_compressed))).toBe(v2["V3-13"].expect.eip55);
  });

  it("V3-16 derives the stealth key pair, including near n", () => {
    const { given, expect: want } = v2["V3-16"];
    expect(h(stealthPublicKey(b(given.spending_pk), b(given.ss)))).toBe(want.stealth_pk);
    expect(h(stealthSecretKey(b(given.spending_sk), b(given.ss)))).toBe(want.stealth_sk);
    expect(h(stealthSecretKey(b(given.spending_sk_near_n), b(given.ss)))).toBe(want.near_n.stealth_sk);
  });

  it("V3-10 refuses invalid scalars instead of reducing them", () => {
    for (const [name, seed] of Object.entries<string>(v2["V3-10"].given.seeds)) {
      if (name.startsWith("spending_seed_0")) expect(isValidScalar(b(seed))).toBe(false);
    }
  });

  it("V3-11 decodes only 1,250-byte meta-addresses", () => {
    const m = v2["V3-11"].given.meta_addresses;
    expect(() => decodeMeta(b(m["1249"]))).toThrow();
    expect(() => decodeMeta(b(m["1251"]))).toThrow();
    expect(() => decodeMeta(b(m["1250"]))).not.toThrow();
  });

  it("V3-12 rejects a field that is not a point", () => {
    const { viewing_pk_ec_nonpoint: bad } = v2["V3-12"].given;
    expect(() => decodeMeta(new Uint8Array([...keys.spendingPk, ...b(bad), ...keys.ek]))).toThrow();
  });

  it("V3-15 skips a malformed announcement instead of throwing", () => {
    expect(openAnnouncement(keys, new Uint8Array(1120), new Uint8Array([1]))).toBeNull();
    expect(openAnnouncement(keys, new Uint8Array(1122), new Uint8Array([1]))).toBeNull();
    expect(openAnnouncement(keys, new Uint8Array(1121), new Uint8Array(0))).toBeNull();
  });

  it("V3-18 skips an announcement whose epk is not a valid point", () => {
    for (const hex of Object.values<string>(v2["V3-18"].given.ephemeralPubKeys).slice(0, -1)) {
      expect(() => openAnnouncement(keys, b(hex), new Uint8Array([0]))).not.toThrow();
    }
  });
});

describe("a payment, sender to recipient", () => {
  const material = new Uint8Array(128);
  for (let i = 0; i < 4; i++) material.set(sha256(new Uint8Array([i + 2])), i * 32);
  const keys = stealthKeygen(material);

  it("the recipient recovers the secret from the announcement", () => {
    const payment = createPayment(decodeMeta(keys.meta));
    const ss = openAnnouncement(keys, payment.ephemeral, new Uint8Array([payment.viewTag]));
    expect(ss && h(ss)).toBe(h(payment.ss));
  });

  it("another recipient does not recover it", () => {
    const other = stealthKeygen(material.map((x, i) => (i < 64 ? x ^ 1 : x ^ 2)));
    const payment = createPayment(decodeMeta(keys.meta));
    const opened = openAnnouncement(other, payment.ephemeral, new Uint8Array([payment.viewTag]));
    expect(opened === null || h(opened) !== h(payment.ss)).toBe(true);
  });

  it("two payments to one recipient do not share an address", () => {
    const a = createPayment(decodeMeta(keys.meta));
    const c = createPayment(decodeMeta(keys.meta));
    expect(stealthCoSigner(keys.spendingPk, a.ss)).not.toBe(stealthCoSigner(keys.spendingPk, c.ss));
  });

  /** What makes the co-signer work: the sender derives an address from public data, and only the recipient's key opens it. */
  it("the key the recipient derives controls the co-signer the sender computed", () => {
    const payment = createPayment(decodeMeta(keys.meta));
    const fromSender = stealthCoSigner(decodeMeta(keys.meta).spendingPk, payment.ss);
    const secret = stealthSecretKey(keys.spendingSk, payment.ss);
    expect(addressOfPublicKey(secp256k1.getPublicKey(secret, true))).toBe(fromSender);
  });

  it("the WOTS seed and the co-signer key are unrelated values", () => {
    const payment = createPayment(decodeMeta(keys.meta));
    expect(h(stealthWotsSeed(payment.ss))).not.toBe(h(stealthSecretKey(keys.spendingSk, payment.ss)));
  });
});
