/** What the wallet does with what Arkiv says. The live run proves the registry; this proves the decisions, including the bad days. */
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeafRegistryWriter, LeafSnapshot } from "@vajra/core/registry";
import { LeafReservedElsewhere, LeafUsedElsewhere, claimLeaf, publishUse, useRegistry } from "../src/registry.ts";

const root = `0x${"aa".repeat(32)}` as Hex;
const me = `0x${"01".repeat(32)}` as Hex;
const them = `0x${"02".repeat(32)}` as Hex;
const account = `0x${"33".repeat(20)}` as const;

const snapshot = (used: number[] = [], reserved: number[] = []) =>
  ({ uses: used.map((leaf) => ({ leaf })), reservations: reserved.map((leaf) => ({ leaf, holder: them })), rejected: 0, ignored: 0, complete: true, block: 0n }) as unknown as LeafSnapshot;

function registry(read: LeafSnapshot | null, reserve: () => Promise<Hex> = async () => "0xentity") {
  const fake = { holder: me, lastFailure: read ? null : "timed out", snapshot: vi.fn(async () => read), reserve: vi.fn(reserve), recordUse: vi.fn(async () => "0xentity" as Hex) };
  useRegistry(fake as unknown as LeafRegistryWriter);
  return fake;
}

const request = (overrides: Partial<Parameters<typeof claimLeaf>[0]> = {}) => ({ root, leaf: 4, account, op: "veto", canSkip: false, log: () => {}, ...overrides });

afterEach(() => useRegistry(null));

describe("claiming a leaf", () => {
  it("leaves everything alone when there is no registry", async () => {
    useRegistry(null);
    expect(await claimLeaf(request())).toBe(4);
  });

  it("reads only from the signer's own counter upward", async () => {
    const fake = registry(snapshot());
    await claimLeaf(request());
    expect(fake.snapshot).toHaveBeenCalledWith(root, { from: 4 });
  });

  it("reserves the leaf before returning, so nothing is signed unclaimed", async () => {
    const fake = registry(snapshot());
    await claimLeaf(request());
    expect(fake.reserve).toHaveBeenCalledWith(root, 4, account);
  });

  it("a software signer moves past a spent leaf, and reserves the one it lands on", async () => {
    const fake = registry(snapshot([4, 5]));
    expect(await claimLeaf(request({ canSkip: true }))).toBe(6);
    expect(fake.reserve).toHaveBeenCalledWith(root, 6, account);
  });

  it("a hardware signer refuses a spent leaf, because it cannot skip", async () => {
    const fake = registry(snapshot([4]));
    await expect(claimLeaf(request())).rejects.toBeInstanceOf(LeafUsedElsewhere);
    expect(fake.reserve).not.toHaveBeenCalled();
  });

  it("refuses a spent leaf even for an escape: signing twice would destroy the key that is escaping", async () => {
    registry(snapshot([4]));
    await expect(claimLeaf(request({ op: "escape" }))).rejects.toBeInstanceOf(LeafUsedElsewhere);
  });

  it("a hardware signer waits out another copy's reservation on an ordinary operation", async () => {
    registry(snapshot([], [4]));
    await expect(claimLeaf(request())).rejects.toBeInstanceOf(LeafReservedElsewhere);
  });

  it.each(["escape", "freeze"])("a reservation cannot stop %s", async (op) => {
    registry(snapshot([], [4]));
    expect(await claimLeaf(request({ op }))).toBe(4);
  });

  it("goes on when Arkiv does not answer: the way out must not depend on it", async () => {
    const lines: string[] = [];
    registry(null);
    expect(await claimLeaf(request({ op: "escape", log: (line) => lines.push(line) }))).toBe(4);
    expect(lines.join()).toContain("did not answer (timed out)");
  });

  it("does not wait for the reservation on an escape", async () => {
    let finish: (entity: Hex) => void = () => {};
    registry(snapshot(), () => new Promise<Hex>((resolve) => (finish = resolve)));
    await expect(claimLeaf(request({ op: "escape" }))).resolves.toBe(4);
    finish("0xentity");
  });

  it("does wait for the reservation on an ordinary operation, so another copy can see it first", async () => {
    let finish: (entity: Hex) => void = () => {};
    registry(snapshot(), () => new Promise<Hex>((resolve) => (finish = resolve)));
    let done = false;
    const claimed = claimLeaf(request()).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    finish("0xentity");
    await claimed;
    expect(done).toBe(true);
  });

  it("survives a reservation that cannot be written, say with no tGLM left", async () => {
    const lines: string[] = [];
    registry(snapshot(), async () => {
      throw new Error("insufficient funds");
    });
    expect(await claimLeaf(request({ log: (line) => lines.push(line) }))).toBe(4);
    expect(lines.join()).toContain("not written: insufficient funds");
  });
});

describe("publishing a use", () => {
  const use = { root, leaf: 4, account, digest: root, signature: "0x04" as Hex, op: "veto" };

  it("does nothing with no registry", async () => {
    useRegistry(null);
    await expect(publishUse(use, () => {})).resolves.toBeUndefined();
  });

  it("reports a failed write and does not throw: the transaction has already gone", async () => {
    const lines: string[] = [];
    const fake = registry(snapshot());
    fake.recordUse.mockRejectedValueOnce(new Error("timed out"));
    await publishUse(use, (line) => lines.push(line));
    expect(lines.join()).toContain("not written: timed out");
  });
});
