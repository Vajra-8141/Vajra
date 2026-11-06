/**
 * Web Push, self-hosted: VAPID (RFC 8292) and message encryption (RFC 8291, aes128gcm from RFC 8188), with nothing but node:crypto.
 *
 * Push works through the browser vendor's push service, so the endpoint is theirs and the alert crosses their network. What this
 * adds over Telegram is that the service only ever sees ciphertext: the text is encrypted to a key the phone made.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

export function newVapid(subject: string): Vapid {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()), subject };
}

/** The raw P-256 scalar and point, as a key node:crypto will sign with. */
function signingKey(v: Vapid) {
  const point = unb64(v.publicKey);
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: v.privateKey, x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) },
    format: "jwk",
  });
}

/** RFC 8292: a short-lived JWT for one push service, signed with ES256, and the public key beside it. */
export function vapidHeader(v: Vapid, endpoint: string, now = Math.floor(Date.now() / 1000)): string {
  const encode = (value: unknown) => b64(Buffer.from(JSON.stringify(value)));
  const claims = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: v.subject })}`;
  const signature = sign("sha256", Buffer.from(claims), { key: signingKey(v), dsaEncoding: "ieee-p1363" });
  return `vapid t=${claims}.${b64(signature)}, k=${v.publicKey}`;
}

const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/** One record, as RFC 8291 section 4 lays it out. `salt` and `sender` are only passed in by the RFC's test vector. */
export function encryptPush(subscription: PushSubscription, plaintext: Uint8Array, fixed?: { salt: Uint8Array; senderPrivateKey: Uint8Array }): Buffer {
  const ua = unb64(subscription.keys.p256dh);
  const auth = unb64(subscription.keys.auth);
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.senderPrivateKey);
  else ecdh.generateKeys();
  const as = ecdh.getPublicKey();
  const salt = fixed?.salt ?? randomBytes(16);

  const shared = ecdh.computeSecret(ua);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last record. A push message is always a single record.
  const body = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([as.length]), as, body]);
}

export type PushResult = "sent" | "gone" | { failed: string };

/** 404 and 410 are how a push service says this subscription no longer exists. */
export async function sendPush(v: Vapid, subscription: PushSubscription, payload: unknown): Promise<PushResult> {
  try {
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidHeader(v, subscription.endpoint),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "3600",
        urgency: "high",
      },
      body: new Uint8Array(encryptPush(subscription, Buffer.from(JSON.stringify(payload)))),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : { failed: `HTTP ${response.status}` };
  } catch (error) {
    return { failed: (error as Error).message };
  }
}

