/**
 * Names for addresses, and what to warn about before money goes to one.
 *
 * A label is the owner's own note. It is not proof of anything: nothing on chain knows it, and a compromised laptop could change
 * it. What a label is good for is the opposite case: an address with no label, that this account has never paid, deserves a
 * hard look, and that is what a thief's address looks like.
 */
import { type Address, getAddress, isAddress } from "viem";

export interface BookEntry {
  label: string;
  addedAt: number;
}

/** Keyed by lower-case address. */
export type Book = Record<string, BookEntry>;

export interface Warning {
  code: "first-seen" | "seen-unknown" | "lookalike";
  level: "danger" | "caution";
  text: string;
}

const MAX_LABEL = 40;

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const key = (address: string) => {
  if (!isAddress(address, { strict: false })) throw new Error(`not an address: ${address}`);
  return address.toLowerCase();
};

export function setLabel(book: Book, address: string, label: string, now = Date.now()): Book {
  const clean = label.trim();
  if (!clean || clean.length > MAX_LABEL) throw new Error(`a label is 1 to ${MAX_LABEL} characters`);
  // A label is shown next to an address, so it must not be able to look like a different one, or hide on the screen.
  if (/[\p{Cc}\p{Cf}]/u.test(clean)) throw new Error("a label cannot hold control characters");
  if (/0x[0-9a-f]{6,}/i.test(clean)) throw new Error("a label cannot hold an address");
  return { ...book, [key(address)]: { label: clean, addedAt: book[key(address)]?.addedAt ?? now } };
}

export function removeLabel(book: Book, address: string): Book {
  const { [key(address)]: _, ...rest } = book;
  return rest;
}

export const labelOf = (book: Book, address: string): string | null => book[key(address)]?.label ?? null;

/** A labelled address that matches this one where people look, and differs in the middle: address poisoning. */
export function lookalikeOf(book: Book, address: string): { address: Address; label: string } | null {
  const mine = key(address);
  for (const [other, entry] of Object.entries(book)) {
    if (other === mine) continue;
    if (other.slice(0, 6) === mine.slice(0, 6) && other.slice(-4) === mine.slice(-4)) return { address: getAddress(other), label: entry.label };
  }
  return null;
}

/**
 * `seenBefore` comes from the chain. Null means the read failed, and that is its own warning: an unknown must not pass for a
 * payee this account has paid.
 */
export function recipientWarnings(book: Book, address: string, seenBefore: boolean | null): Warning[] {
  const warnings: Warning[] = [];
  const lookalike = lookalikeOf(book, address);
  if (lookalike) {
    warnings.push({
      code: "lookalike",
      level: "danger",
      text: `This looks like ${lookalike.label} (${shortAddress(lookalike.address)}) but it is a different address. Thieves make addresses like this on purpose.`,
    });
  }
  if (labelOf(book, address)) return warnings;
  if (seenBefore === false) warnings.push({ code: "first-seen", level: "danger", text: "First time this account pays this address, and it is not in your address book. Check every character." });
  if (seenBefore === null) warnings.push({ code: "seen-unknown", level: "caution", text: "Could not read whether this account has paid this address before. Treat it as new." });
  return warnings;
}
