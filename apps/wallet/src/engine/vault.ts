/**
 * Keys at rest. Everything secret is one AES-GCM blob, under a key stretched from the passphrase, in this browser's storage.
 *
 * Which one-time signatures have been used is kept outside the blob, and in the clear. It has to be written before a signature
 * leaves, synchronously, and encryption in a browser is asynchronous. It is not secret: each one is public once used.
 */
const ITERATIONS = 600_000;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export interface Sealed {
  vajra: "wallet";
  version: 1;
  salt: string;
  iv: string;
  data: string;
}

export async function stretch(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export const newSalt = () => crypto.getRandomValues(new Uint8Array(16));

export async function seal(key: CryptoKey, salt: Uint8Array, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { vajra: "wallet", version: 1, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) };
}

export async function open<T>(sealed: Sealed, passphrase: string): Promise<{ value: T; key: CryptoKey; salt: Uint8Array }> {
  const salt = unb64(sealed.salt);
  const key = await stretch(passphrase, salt);
  const plain = await crypto.subtle
    .decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource }, key, unb64(sealed.data) as BufferSource)
    .catch(() => {
      throw new Error("That passphrase doesn't open this wallet.");
    });
  return { value: JSON.parse(new TextDecoder().decode(plain)) as T, key, salt };
}

export const encode = (sealed: Sealed) => b64(new TextEncoder().encode(JSON.stringify(sealed)));
export const decode = (text: string) => JSON.parse(new TextDecoder().decode(unb64(text))) as Sealed;
