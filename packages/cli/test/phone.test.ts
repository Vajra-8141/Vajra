/** The cryptography under the phone and the backup, each checked against something other than itself. */
import { createDecipheriv, createECDH, createHash, createPublicKey, generateKeyPairSync, hkdfSync, sign, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { type BackupContents, decryptBackup, encryptBackup } from "../src/backup.ts";
import { type Assertion, Challenges, type StoredPasskey, acceptRegistration, verifyAssertion } from "../src/passkey.ts";
import { encryptPush, newVapid, vapidHeader } from "../src/webpush.ts";

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

describe("Web Push", () => {
  // RFC 8291, Appendix A.
  it("matches the RFC's worked example, byte for byte", () => {
    const body = encryptPush(
      { endpoint: "https://push.example.net/x", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } },
      Buffer.from("When I grow up, I want to be a watermelon"),
      { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), senderPrivateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url") },
    );
    expect(b64(body)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  });

  it("decrypts with the phone's key, and is different every time", () => {
    const phone = createECDH("prime256v1");
    phone.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const subscription = { endpoint: "https://x.example/1", keys: { p256dh: b64(phone.getPublicKey()), auth: b64(auth) } };
    const body = encryptPush(subscription, Buffer.from("0.5 ETH"));
    expect(encryptPush(subscription, Buffer.from("0.5 ETH")).equals(body)).toBe(false);

    const salt = body.subarray(0, 16);
    const as = body.subarray(21, 86);
    const ikm = Buffer.from(hkdfSync("sha256", phone.computeSecret(as), auth, Buffer.concat([Buffer.from("WebPush: info\0"), phone.getPublicKey(), as]), 32));
    const decipher = createDecipheriv("aes-128-gcm", Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)), Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)));
    decipher.setAuthTag(body.subarray(-16));
    expect(Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]).toString()).toBe("0.5 ETH\u0002");
  });

  it("signs a VAPID token a push service can check", () => {
    const vapid = newVapid("mailto:owner@localhost");
    const [, jwt, key] = /^vapid t=(.+), k=(.+)$/.exec(vapidHeader(vapid, "https://fcm.googleapis.com/fcm/send/abc", 1000))!;
    const [head, claims, signature] = jwt!.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: 1000 + 12 * 3600, sub: "mailto:owner@localhost" });
    const point = Buffer.from(key!, "base64url");
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("the passkey check", () => {
  const origin = "http://localhost:3210";
  const rpId = "localhost";
  const challenge = "abc";
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const stored: StoredPasskey = { id: "cred", publicKey: b64(publicKey.export({ type: "spki", format: "der" })), algorithm: -7, signCount: 5 };

  function answer(o: { flags?: number; count?: number; rp?: string; type?: string; challenge?: string; origin?: string; id?: string } = {}): Assertion {
    const clientData = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: o.challenge ?? challenge, origin: o.origin ?? origin }));
    const count = Buffer.alloc(4);
    count.writeUInt32BE(o.count ?? 6);
    const authData = Buffer.concat([createHash("sha256").update(o.rp ?? rpId).digest(), Buffer.from([o.flags ?? 5]), count]);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), privateKey);
    return { id: o.id ?? "cred", clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature) };
  }
  const check = (assertion: Assertion) => verifyAssertion({ stored, assertion, challenge, origin, rpId });

  it("accepts a good answer and returns the counter", () => {
    expect(check(answer())).toBe(6);
  });

  it("accepts an authenticator that keeps no counter", () => {
    expect(check(answer({ count: 0 }))).toBe(0);
  });

  it.each([
    ["no user verification", { flags: 1 }, "verify the user"],
    ["nobody present", { flags: 4 }, "nobody was present"],
    ["another challenge", { challenge: "other" }, "different challenge"],
    ["another origin", { origin: "https://evil.example" }, "used from"],
    ["another site's passkey", { rp: "evil.example" }, "another site"],
    ["a registration replayed", { type: "webauthn.create" }, "different kind"],
    ["a counter going backwards", { count: 5 }, "backwards"],
    ["another credential", { id: "other" }, "not the passkey"],
  ])("refuses %s", (_, change, reason) => {
    expect(() => check(answer(change))).toThrow(reason);
  });

  it("refuses a signature from another key", () => {
    const good = answer();
    expect(() => check({ ...good, signature: answer({ count: 7 }).signature })).toThrow("does not verify");
  });

  it("spends a challenge once, for its one purpose, and lets it expire", () => {
    const challenges = new Challenges();
    const issued = challenges.issue("pay:1", 0);
    expect(challenges.take("pay:2", 0)).toBeNull();
    expect(challenges.take("pay:1", 0)).toBe(issued);
    expect(challenges.take("pay:1", 0)).toBeNull();
    challenges.issue("pay:1", 0);
    expect(challenges.take("pay:1", 60_001)).toBeNull();
  });

  it("registers ES256 only", () => {
    const clientDataJSON = b64(JSON.stringify({ type: "webauthn.create", challenge, origin }));
    const registration = { id: "cred", publicKey: stored.publicKey, clientDataJSON, challenge, origin };
    expect(acceptRegistration({ ...registration, algorithm: -7 }).signCount).toBe(0);
    expect(() => acceptRegistration({ ...registration, algorithm: -257 })).toThrow("ES256");
  });
});

describe("the backup file", () => {
  const contents: BackupContents = {
    createdAt: "2026-11-06T00:00:00.000Z",
    chainId: 13370,
    genesis: `0x${"11".repeat(32)}` as Hex,
    wallet: { account: `0x${"22".repeat(20)}` as Address, harbor: `0x${"33".repeat(20)}` as Address, harborSalt: `0x${"44".repeat(32)}` as Hex },
    signer: { seed: `0x${"55".repeat(32)}` as Hex, nextLeaf: 2, revealed: { 0: `0x${"66".repeat(32)}` as Hex } },
    nextSigner: null,
    root: `0x${"77".repeat(32)}` as Hex,
  };
  const fast = { N: 1024, r: 8, p: 1 };
  const pass = "correct horse battery";

  it("comes back whole, and hides the seed", async () => {
    const file = await encryptBackup(contents, pass, fast);
    expect(JSON.stringify(file)).not.toContain("5555");
    expect(await decryptBackup(file, pass)).toEqual(contents);
  });

  it("refuses a short passphrase", async () => {
    await expect(encryptBackup(contents, "short", fast)).rejects.toThrow("at least 12");
  });

  it("refuses the wrong passphrase", async () => {
    await expect(decryptBackup(await encryptBackup(contents, pass, fast), "another passphrase")).rejects.toThrow("wrong passphrase");
  });

  it("refuses a header that was changed, even with the right passphrase", async () => {
    const file = await encryptBackup(contents, pass, fast);
    await expect(decryptBackup({ ...file, kdf: { ...file.kdf, p: 2 } }, pass)).rejects.toThrow("wrong passphrase");
  });

  it("refuses what is not a backup", async () => {
    await expect(decryptBackup({ vajra: "other" } as never, pass)).rejects.toThrow("not a VAJRA backup");
  });
});

describe("the signer lock", () => {
  it("runs one at a time, and clears a lock left by a dead process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vajra-lock-"));
    process.env.VAJRA_STATE_DIR = dir;
    const { withSignerLock } = await import("../src/signer-lock.ts");
    const order: string[] = [];
    const job = (name: string) =>
      withSignerLock(async () => {
        order.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`${name} out`);
      });
    await Promise.all([job("a"), job("b")]);
    expect(order[1]).toBe(`${order[0]!.split(" ")[0]} out`);

    // Above the kernel's highest pid, so nothing can be running as it.
    writeFileSync(join(dir, "signer.lock"), "4194305");
    await expect(withSignerLock(async () => "ran", 2000)).resolves.toBe("ran");
    delete process.env.VAJRA_STATE_DIR;
  });

  it("gives up on a live holder, and does not take the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vajra-lock-"));
    process.env.VAJRA_STATE_DIR = dir;
    const { withSignerLock } = await import("../src/signer-lock.ts");
    writeFileSync(join(dir, "signer.lock"), String(process.pid));
    await expect(withSignerLock(async () => "ran", 300)).rejects.toThrow("too long");
    delete process.env.VAJRA_STATE_DIR;
  });
});
