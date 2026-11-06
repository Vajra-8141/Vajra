import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { type PoolFacts, poolMeter, poolWords } from "../src/pool.ts";

const account = "0x00c0ffee0000000000000000000000000000c0ff" as Address;
const friend = "0x1111111111111111111111111111111111111111" as Address;
const stranger = "0x2222222222222222222222222222222222222222" as Address;
const facts = (depositors: (Address | null)[], withdrawn = 0, closed = false): PoolFacts => ({ account, closed, depositors, withdrawn });
const read = (f: PoolFacts) => {
  const meter = poolMeter(f);
  return { meter, words: poolWords(meter) };
};
const everything = (words: ReturnType<typeof read>["words"]) => [words.headline, ...words.shows, ...words.unknown, ...words.cannotShow].join(" ");

describe("the pool meter", () => {
  it("says an owner alone in their pool hides nothing, however many notes there are", () => {
    const { meter, words } = read(facts(Array(30).fill(account)));
    expect(meter.state).toBe("hides nothing");
    expect(meter.addresses).toBe(1);
    expect(words.headline).toContain("plainly yours");
  });

  it("does not count notes as people: thirty notes from two addresses is two", () => {
    const { meter, words } = read(facts([...Array(29).fill(friend), account]));
    expect(meter.state).toBe("hides little");
    expect(meter.addresses).toBe(2);
    expect(words.headline).toContain("at most 2 addresses");
    expect(words.shows.join(" ")).toContain("right about 29 times in 30");
  });

  it("counts an address once, whatever its case", () => {
    expect(poolMeter(facts([friend, friend.toUpperCase().replace("0X", "0x") as Address, account])).addresses).toBe(2);
  });

  it("marks which share is the account's own", () => {
    const { meter } = read(facts([account, friend, friend, stranger]));
    expect(meter.shares).toEqual([
      { address: friend, notes: 2, own: false },
      { address: account, notes: 1, own: true },
      { address: stranger, notes: 1, own: false },
    ]);
  });

  it("never turns an unknown sender into a smaller or a larger count", () => {
    const { meter, words } = read(facts([account, null, friend]));
    expect(meter.state).toBe("unknown");
    expect(meter.addresses).toBeNull();
    expect(meter.shares).toBeNull();
    expect(words.headline).toMatch(/^Unknown/);
    expect(words.unknown.join(" ")).toContain("the number of addresses is unknown");
    expect(everything(words)).not.toMatch(/\b0 addresses\b/);
  });

  it("tells an empty pool from an unread one, and from one every note has left", () => {
    expect(read(facts([])).words.headline).toContain("Nothing has been paid in");
    expect(read(facts([account, friend], 2)).words.headline).toContain("Every note has left");
    expect(read(facts([account, friend], 2)).meter.state).toBe("empty");
  });

  it("calls a pool closed after an escape, whatever it held", () => {
    const { meter, words } = read(facts([account, friend], 0, true));
    expect(meter.state).toBe("closed");
    expect(words.headline).toContain("harbor");
  });

  it("never says the pool hides you well, at any size", () => {
    const crowd = Array.from({ length: 5000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
    const { meter, words } = read(facts([account, ...crowd]));
    expect(meter.state).toBe("hides little");
    expect(everything(words)).not.toMatch(/\b(anonymous|private|safe|secure|well hidden|untraceable)\b/i);
  });

  it("always keeps the limits, in every state", () => {
    for (const f of [facts([]), facts([account]), facts([account, friend]), facts([account, null]), facts([account], 0, true)]) {
      const { words } = read(f);
      expect(words.cannotShow.join(" ")).toContain("different people");
      expect(words.cannotShow.join(" ")).toContain("Which note left");
      expect(words.shows.join(" ")).toContain("not that");
    }
  });

  it("states the ceiling as at most, never at least", () => {
    const { words } = read(facts([account, friend, stranger]));
    expect(words.headline).toContain("at most 3");
    expect(everything(words)).toContain("never at least");
    expect(words.headline).not.toMatch(/at least/);
  });
});
