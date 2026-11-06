/** The daily key at rest: AES-GCM under a key stretched from the owner's password. It is only ever in the clear in session storage. */
export interface Vault {
  salt: string;
  iv: string;
  iterations: number;
  data: string;
}

/** OWASP's figure for PBKDF2-HMAC-SHA256. */
const ITERATIONS = 600_000;
const MIN_PASSWORD = 8;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function stretch(password: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, password: string, iterations = ITERATIONS): Promise<Vault> {
  if (password.length < MIN_PASSWORD) throw new Error(`a password is at least ${MIN_PASSWORD} characters`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await stretch(password, salt, iterations), new TextEncoder().encode(secret));
  return { salt: b64(salt), iv: b64(iv), iterations, data: b64(new Uint8Array(data)) };
}

export async function open(vault: Vault, password: string): Promise<string> {
  try {
    const key = await stretch(password, unb64(vault.salt), vault.iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) as BufferSource }, key, unb64(vault.data) as BufferSource);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("wrong password");
  }
}
