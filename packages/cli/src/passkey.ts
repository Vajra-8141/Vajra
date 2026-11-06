/**
 * Checking a passkey before Pay, on the phone and in the local service.
 *
 * This is an app-level second factor and nothing more. The contracts do not know it exists, and a master signature made any other way
 * does not need it. What it does: a stolen phone that is already paired still cannot pay without the phone's own screen lock.
 *
 * The browser's own check could be skipped by a compromised page, so the service verifies the assertion itself. Each challenge
 * names one action on one item and works once.
 */
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

export interface StoredPasskey {
  id: string;
  /** SubjectPublicKeyInfo, base64url, from the browser's `getPublicKey()`. */
  publicKey: string;
  algorithm: number;
  signCount: number;
}

export interface Assertion {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

const CHALLENGE_MS = 60_000;
const USER_PRESENT = 1;
const USER_VERIFIED = 4;
const ES256 = -7;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();
const bytes = (text: string) => Buffer.from(text, "base64url");

/** A one-time challenge for each purpose. Taking one for a purpose again replaces it. */
export class Challenges {
  private open = new Map<string, { challenge: string; expires: number }>();

  issue(purpose: string, now = Date.now()) {
    const challenge = randomBytes(32).toString("base64url");
    this.open.set(purpose, { challenge, expires: now + CHALLENGE_MS });
    return challenge;
  }

  /** Spends it, right or wrong: a failed guess does not get a second try at the same one. */
  take(purpose: string, now = Date.now()): string | null {
    const found = this.open.get(purpose);
    this.open.delete(purpose);
    return found && found.expires > now ? found.challenge : null;
  }
}

function checkClientData(json: Buffer, a: { type: string; challenge: string; origin: string }) {
  const data = JSON.parse(json.toString("utf8")) as { type?: string; challenge?: string; origin?: string };
  if (data.type !== a.type) throw new Error("the passkey answered a different kind of request");
  if (data.challenge !== a.challenge) throw new Error("the passkey signed a different challenge");
  if (data.origin !== a.origin) throw new Error(`the passkey was used from ${data.origin}`);
}

/** Registration trusts the paired session for the key itself: there is no attestation, only "this phone's key". */
export function acceptRegistration(a: { id: string; publicKey: string; algorithm: number; clientDataJSON: string; challenge: string; origin: string }): StoredPasskey {
  if (a.algorithm !== ES256) throw new Error("only ES256 passkeys are supported");
  checkClientData(bytes(a.clientDataJSON), { type: "webauthn.create", challenge: a.challenge, origin: a.origin });
  createPublicKey({ key: bytes(a.publicKey), format: "der", type: "spki" });
  return { id: a.id, publicKey: a.publicKey, algorithm: a.algorithm, signCount: 0 };
}

/** Returns the new signature counter. Throws with the reason on anything else. */
export function verifyAssertion(a: { stored: StoredPasskey; assertion: Assertion; challenge: string; origin: string; rpId: string }): number {
  const { stored, assertion } = a;
  if (assertion.id !== stored.id) throw new Error("that is not the passkey registered for this phone");
  const clientData = bytes(assertion.clientDataJSON);
  checkClientData(clientData, { type: "webauthn.get", challenge: a.challenge, origin: a.origin });

  const authData = bytes(assertion.authenticatorData);
  if (authData.length < 37) throw new Error("the passkey's answer is too short");
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(a.rpId)))) throw new Error("the passkey belongs to another site");
  const flags = authData[32]!;
  if (!(flags & USER_PRESENT)) throw new Error("the passkey says nobody was present");
  if (!(flags & USER_VERIFIED)) throw new Error("the passkey did not verify the user");
  const signCount = authData.readUInt32BE(33);
  // Zero means this authenticator keeps no counter, which passkeys that sync do not.
  if (signCount !== 0 && signCount <= stored.signCount) throw new Error("the passkey's counter went backwards: it may have been copied");

  const key = createPublicKey({ key: bytes(stored.publicKey), format: "der", type: "spki" });
  if (!verify("sha256", Buffer.concat([authData, sha256(clientData)]), key, bytes(assertion.signature))) throw new Error("the passkey's signature does not verify");
  return signCount;
}
