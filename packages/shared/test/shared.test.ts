/** The decisions that need no chain: what gets a warning, and what a dapp's request may become. */
import { describe, expect, it } from "vitest";
import { type Address, encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { labelOf, lookalikeOf, recipientWarnings, removeLabel, setLabel } from "../src/addressbook.ts";
import { MOVE_FEES, moveConfig, planMove } from "../src/move.ts";
import { ProviderError, paymentFrom } from "../src/request.ts";
import { describeItem } from "../src/review.ts";

const A = "0x1111111111111111111111111111111111111111" as Address;
const LOOKALIKE = "0x1111112222222222222222222222222222221111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;

describe("the address book", () => {
  it("keeps a label, whatever the case of the address", () => {
    const book = setLabel({}, A, " Asha ");
    expect(labelOf(book, A.toUpperCase().replace("0X", "0x"))).toBe("Asha");
    expect(labelOf(removeLabel(book, A), A)).toBeNull();
  });

  it.each(["", "   ", "x".repeat(41), "pay‮me", "line\nbreak", "0xdeadbeef00"])("refuses the label %j", (label) => {
    expect(() => setLabel({}, A, label)).toThrow();
  });

  it("refuses what is not an address", () => {
    expect(() => setLabel({}, "0x12", "Asha")).toThrow();
  });

  it("warns on an unlabelled address this account never paid", () => {
    expect(recipientWarnings({}, A, false).map((w) => w.code)).toEqual(["first-seen"]);
  });

  it("does not warn on a label, or a payee seen before", () => {
    expect(recipientWarnings(setLabel({}, A, "Asha"), A, false)).toEqual([]);
    expect(recipientWarnings({}, A, true)).toEqual([]);
  });

  it("treats an unknown history as a warning of its own, never as seen", () => {
    expect(recipientWarnings({}, A, null).map((w) => w.code)).toEqual(["seen-unknown"]);
  });

  it("catches an address made to look like a labelled one", () => {
    const book = setLabel({}, A, "Asha");
    expect(lookalikeOf(book, LOOKALIKE)?.label).toBe("Asha");
    expect(lookalikeOf(book, A)).toBeNull();
    expect(lookalikeOf(book, B)).toBeNull();
    expect(recipientWarnings(book, LOOKALIKE, true).map((w) => w.code)).toEqual(["lookalike"]);
  });
});

describe("a dapp's transaction", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as ProviderError).code;
    }
    return null;
  };
  const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address, uint256) returns (bool)"]), functionName: "transfer", args: [B, 5n] });

  it("reads an ETH payment", () => {
    expect(paymentFrom({ to: B, value: "0x10" }, A)).toEqual({ asset: zeroAddress, recipient: B, amount: 16n });
  });

  it("reads a token transfer: the token is the asset, and the recipient comes from the calldata", () => {
    expect(paymentFrom({ to: TOKEN, data: transfer }, A)).toEqual({ asset: TOKEN, recipient: B, amount: 5n });
    expect(paymentFrom({ to: TOKEN, input: transfer }, A).recipient).toBe(B);
  });

  it("refuses anything else", () => {
    expect(code(() => paymentFrom({ to: TOKEN, data: "0x095ea7b3" }, A))).toBe(4200);
    expect(code(() => paymentFrom({ to: TOKEN, data: transfer, value: "0x1" }, A))).toBe(4200);
    expect(code(() => paymentFrom({ data: "0x60" }, A))).toBe(4200);
    expect(code(() => paymentFrom({ to: "0x12" }, A))).toBe(4200);
  });

  it("refuses to send from another address", () => {
    expect(code(() => paymentFrom({ from: B, to: B }, A))).toBe(4100);
  });
});

describe("a queued item", () => {
  const item = { id: 3n, recipient: B, asset: zeroAddress, amount: parseEther("0.5"), executeAfter: 1000n, state: 1 };
  const base = { item, book: {}, now: 400, recovery: false, seenBefore: false, token: null, reason: 1 as const };

  it("says who, how much, when and why", () => {
    const view = describeItem(base);
    expect(view.headline).toBe("0.5 ETH to 0x2222…2222. It leaves in 10 min unless you stop it.");
    expect(view.reason).toBe("new-payee");
    expect(view.warnings.map((w) => w.code)).toEqual(["first-seen"]);
  });

  it("uses the label", () => {
    expect(describeItem({ ...base, book: setLabel({}, B, "Asha") }).headline).toContain("to Asha.");
  });

  it("says when the reason is unknown, and does not make one up", () => {
    const view = describeItem({ ...base, reason: null });
    expect(view.reason).toBeNull();
    expect(view.reasonText).toContain("unknown");
  });

  it("shows a token that will not describe itself as unknown, with the raw amount", () => {
    expect(describeItem({ ...base, item: { ...item, asset: TOKEN, amount: 7n } }).amountText).toBe("7 units of unknown token 0x3333…3333");
  });

  it("formats a token that does", () => {
    expect(describeItem({ ...base, item: { ...item, asset: TOKEN, amount: 1_500_000n }, token: { symbol: "USDC", decimals: 6 } }).amountText).toBe("1.5 USDC");
  });

  it("marks a recovery as one", () => {
    expect(describeItem({ ...base, recovery: true }).kind).toBe("recovery");
  });
});

describe("the move", () => {
  const options = {
    eoa: A,
    wotsRoot: `0x${"aa".repeat(32)}`,
    epochSalt: `0x${"bb".repeat(32)}`,
    harborCommitment: `0x${"cc".repeat(32)}`,
    dailyLimit: "0.1",
    coolingAllowance: "0.01",
    queueDelay: 60,
    coolingPeriod: 30,
    tokens: [TOKEN],
    stake: 0n,
    unstakeDelay: 0,
  } as const;
  const config = moveConfig({ ...options, tokens: [TOKEN] });
  const plan = (ether: bigint, balance: bigint) => planMove({ factory: B, account: B, config, eoa: A, holdings: { nonce: 4n, ether, tokens: [{ address: TOKEN, balance }] } });

  it("keeps the EOA as the daily key, and gives a listed token a limit of zero", () => {
    expect(config.dailyKey).toBe(A);
    expect(config.assets).toEqual([zeroAddress, TOKEN]);
    expect(config.dailyLimits[1]).toBe(0n);
  });

  it("ties every frame to the next, except the last", () => {
    const { tx } = plan(parseEther("1"), 5n);
    expect(tx.frames.length).toBe(3);
    expect(tx.frames.slice(1).map((frame) => frame.flags)).toEqual([4, 0]);
    expect(tx.nonceSeq).toBe(4n);
  });

  it("reserves the whole gas limit, so the transaction can pay for itself", () => {
    const { ether, maxCost } = plan(parseEther("1"), 5n);
    expect(ether + maxCost).toBe(parseEther("1"));
    expect(maxCost).toBeGreaterThan(MOVE_FEES.maxFeePerGas * 6_000_000n);
  });

  it("adds no frame for a token with no balance", () => {
    expect(plan(parseEther("1"), 0n).tx.frames.length).toBe(2);
  });

  it("refuses a wallet that cannot pay for the move", () => {
    expect(() => plan(1000n, 5n)).toThrow("too little ETH");
  });
});
