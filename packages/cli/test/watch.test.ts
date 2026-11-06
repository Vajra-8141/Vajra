/** The decisions between a phone tap and the master key. Every refusal here is one way a tap could otherwise move money. */
import { describe, expect, it } from "vitest";
import { alertMessage, decide, parseButton } from "../src/watch.ts";

const base = { owner: 42, pending: new Set([3n]), recoveries: new Set<bigint>(), hardware: true, allowSoftwarePay: false };
const owner = (data: string) => ({ from: 42, data });

describe("buttons", () => {
  it("reads what the alert sends", () => {
    expect(parseButton("veto:3")).toEqual({ action: "veto", id: 3n });
    expect(parseButton("pay:12")).toEqual({ action: "pay", id: 12n });
  });

  it.each(["", "veto", "veto:", "veto:-1", "veto:1 ", "pay:1;veto:2", "freeze:1", "escape:0", "veto:0x1"])("refuses %j", (data) => {
    expect(parseButton(data)).toBeNull();
  });

  it("refuses no data at all", () => {
    expect(parseButton(undefined)).toBeNull();
  });
});

describe("a tap", () => {
  it("cancels for the owner", () => {
    expect(decide(owner("veto:3"), { ...base, hardware: false })).toEqual({ ok: true, button: { action: "veto", id: 3n } });
  });

  it("pays for the owner with the hardware signer", () => {
    expect(decide(owner("pay:3"), base)).toEqual({ ok: true, button: { action: "pay", id: 3n } });
  });

  it("is refused from anyone else, even with a real button", () => {
    expect(decide({ from: 7, data: "veto:3" }, base).ok).toBe(false);
    expect(decide({ from: 7, data: "pay:3" }, base).ok).toBe(false);
  });

  it("is refused for an item that is not waiting", () => {
    expect(decide(owner("veto:9"), base).ok).toBe(false);
    expect(decide(owner("pay:9"), base).ok).toBe(false);
  });

  it("cannot pay on a software signer, so a phone alone cannot move money", () => {
    const software = { ...base, hardware: false };
    expect(decide(owner("pay:3"), software)).toMatchObject({ ok: false });
    expect(decide(owner("veto:3"), software).ok).toBe(true);
  });

  it("can pay on a software signer only when told to", () => {
    expect(decide(owner("pay:3"), { ...base, hardware: false, allowSoftwarePay: true }).ok).toBe(true);
  });

  it("cannot release a recovery early, on any signer", () => {
    const recovery = { ...base, recoveries: new Set([3n]), allowSoftwarePay: true };
    expect(decide(owner("pay:3"), recovery)).toMatchObject({ ok: false });
    expect(decide(owner("veto:3"), recovery).ok).toBe(true);
  });
});

describe("the alert", () => {
  const item = { id: 3n, recipient: "0x000000000000000000000000000000000000bEEF", asset: "0x0000000000000000000000000000000000000000", amount: 5n * 10n ** 17n, secondsLeft: 118, recovery: false } as const;

  it("says the amount, the recipient and the time, and offers both buttons", () => {
    const { text, buttons } = alertMessage(item);
    expect(text).toContain("0.5 ETH");
    expect(text).toContain(item.recipient);
    expect(text).toContain("2 min");
    expect(buttons.map((b) => b.callback_data)).toEqual(["veto:3", "pay:3"]);
  });

  it("says nothing of a rescue when nobody holds one", () => {
    expect(alertMessage(item).text).not.toContain("nominee");
  });

  it("says when a nominee's rescue goes, because the answer is what stops it", () => {
    expect(alertMessage({ ...item, rescueMargin: 30 }).text).toContain("your nominee's rescue moves everything to your harbor in 2 min");
    expect(alertMessage({ ...item, secondsLeft: 10, rescueMargin: 30 }).text).toContain("in 0 min");
    expect(alertMessage({ ...item, recovery: true, rescueMargin: 30 }).text).toContain("your nominee's rescue");
  });

  it("offers no Pay on a recovery", () => {
    expect(alertMessage({ ...item, recovery: true }).buttons.map((b) => b.callback_data)).toEqual(["veto:3"]);
  });
});
