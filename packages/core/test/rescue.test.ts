import * as lib from "@forshtat/hegota-support/tx";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { type FrameTx, MasterSigner, RescueInvalid, WOTS_W16, accountAbi, defaultMargin, encodeTx, exitTx, memoryStore, ops, parseRescue, profile, rescueCall, rescueFile, signExitTx, signRescue } from "../src/index.ts";

const account = "0x1111111111111111111111111111111111111111" as const;
const exit = "0x2222222222222222222222222222222222222222" as const;
const harbor = "0x3333333333333333333333333333333333333333" as const;
const thief = "0x4444444444444444444444444444444444444444" as const;
const harborSalt = keccak256(toHex("harbor"));
const epochSalt = keccak256(toHex("epoch"));
const genesis = keccak256(toHex("genesis"));
const signer = () => new MasterSigner(WOTS_W16, memoryStore(), () => new Uint8Array(32).fill(5));

const signed = () => signRescue({ signer: signer(), exit, account, epochSalt, harbor, harborSalt, tokens: 1, extra: [thief] }).tx;
const filed = (tx: FrameTx, over: Record<string, unknown> = {}) => JSON.stringify({ ...JSON.parse(rescueFile({ tx, genesis, marginSeconds: 15 })), ...over });

describe("a rescue file", () => {
  it("reads everything from the signed bytes", () => {
    const rescue = parseRescue(rescueFile({ tx: signed(), genesis, marginSeconds: 15 }));
    expect(rescue.account).toBe(account);
    expect(rescue.exit).toBe(exit);
    expect(rescue.harbor).toBe(harbor);
    expect(rescue.harborSalt).toBe(harborSalt);
    expect(rescue.extraTokens).toEqual([thief]);
    expect(rescue.marginSeconds).toBe(15);
    expect(rescue.maxCost > 0n).toBe(true);
  });

  it("refuses what is not a file of ours", () => {
    expect(() => parseRescue("not json")).toThrow(RescueInvalid);
    expect(() => parseRescue("null")).toThrow(RescueInvalid);
    expect(() => parseRescue(filed(signed(), { kind: "something else" }))).toThrow(RescueInvalid);
    expect(() => parseRescue(filed(signed(), { tx: "0x06aa" }))).toThrow(RescueInvalid);
    expect(() => parseRescue(filed(signed(), { marginSeconds: -1 }))).toThrow(RescueInvalid);
    expect(() => parseRescue(filed(signed(), { genesis: "0x" }))).toThrow(RescueInvalid);
  });

  // A real signature from the real tree, on anything but an escape, must not pass: a holder would be sending something they were not told about.
  for (const [what, call] of [
    ["a veto", ops.veto(0n)],
    ["a freeze", ops.freeze()],
    ["a call that replaces the daily key", ops.setDailyKey(thief)],
  ] as const) {
    it(`refuses ${what}, even signed by the real exit tree`, () => {
      const { tx } = signExitTx({ signer: signer(), exit, account, epochSalt, calls: [call] });
      expect(() => parseRescue(filed(tx))).toThrow(/a rescue only escapes|not an escape/);
    });
  }

  it("refuses a frame added after the escape", () => {
    const tx = signed();
    const extra = lib.frame(profile, "SENDER", { target: thief, execution: 100_000n, value: 1n, data: "0x" });
    expect(() => parseRescue(filed({ ...tx, frames: [...tx.frames, extra] }))).toThrow(/exactly one VERIFY/);
  });

  it("refuses a first frame that is not the exit's own check", () => {
    const tx = signed();
    const frames = [{ ...tx.frames[0]!, target: thief }, tx.frames[1]!];
    expect(() => parseRescue(filed({ ...tx, frames }))).toThrow(/not an exit's own check/);
    const other = [{ ...tx.frames[0]!, data: encodeFunctionData({ abi: accountAbi, functionName: "validateMaster", args: [3] }) }, tx.frames[1]!];
    expect(() => parseRescue(filed({ ...tx, frames: other }))).toThrow(/not an exit's own check/);
  });

  it("refuses a second frame with value, or with another mode", () => {
    const tx = signed();
    expect(() => parseRescue(filed({ ...tx, frames: [tx.frames[0]!, { ...tx.frames[1]!, value: 1n }] }))).toThrow(/not a plain call/);
    expect(() => parseRescue(filed({ ...tx, frames: [tx.frames[0]!, { ...tx.frames[1]!, mode: profile.frameModes.DEFAULT! }] }))).toThrow(/not a plain call/);
  });

  it("refuses one with no signature, or signed by something other than a hash key", () => {
    const unsigned = exitTx({ exit, account, root: signer().root, leaf: 0, calls: [rescueCall(harbor, harborSalt, 0)] });
    expect(() => parseRescue(filed(unsigned))).toThrow(/not signed by a hash key/);
    const tx = signed();
    const entry = { ...tx.signatures[0]!, scheme: profile.sigSchemes.SECP256K1! };
    expect(() => parseRescue(filed({ ...tx, signatures: [entry] }))).toThrow(/not signed by a hash key/);
  });

  it("refuses one for another chain", () => {
    const tx = { ...signed(), chainId: 999n };
    expect(() => parseRescue(JSON.stringify({ kind: "vajra-rescue-v1", chainId: 999, genesis, marginSeconds: 15, tx: encodeTx(tx) }))).toThrow(/for chain 999/);
  });
});

describe("what a rescue pays for", () => {
  it("allows for a token that fights, on top of what an escape already has", () => {
    const plain = ops.escape(harbor, harborSalt);
    const two = rescueCall(harbor, harborSalt, 2);
    expect(two.execution).toBe(plain.execution + 1_200_000n);
    expect(two.state).toBe(plain.state + 200_000n);
  });

  it("goes out a quarter of the delay early, and never more than an hour", () => {
    expect(defaultMargin(60)).toBe(15);
    expect(defaultMargin(3600)).toBe(900);
    expect(defaultMargin(86_400)).toBe(3600);
  });
});
