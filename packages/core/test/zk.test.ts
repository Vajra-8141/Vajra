import { encodeErrorResult, keccak256, toBytes, concat, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { ATOMIC_BATCH_FLAG, ETH, type FlatProof, PROOF_FRAME_GAS, accountV2Abi, masterTx, releaseCalls, encodeTx, opsV2, recoveryNonceKey, recoveryTx, refusalNameV2, txHash, unshieldNonceKey, unshieldTx } from "../src/index.ts";

const account = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const root = `0x${"cd".repeat(32)}` as const;
const proof = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as unknown as FlatProof;

describe("proof transactions", () => {
  it("is exactly [VERIFY, SENDER], because that is all the account approves", () => {
    for (const tx of [
      recoveryTx({ account, newRoot: root, nullifier: 9n, proof, ticket: root }),
      unshieldTx({ account, root: 5n, nullifierHash: 9n, recipient, proof, work: 0n }),
    ]) {
      expect(tx.frames).toHaveLength(2);
      expect(tx.signatures).toHaveLength(0);
      expect(tx.nonceKeys).toHaveLength(1);
      expect(tx.nonceSeq).toBe(0n);
    }
  });

  it("derives the nonce key the contract derives", () => {
    const word = numberToHex(9n, { size: 32 });
    expect(recoveryNonceKey(9n, root)).toBe(BigInt(keccak256(concat([keccak256(toBytes("vajra.recovery.v1")), word, root]))));
    expect(unshieldNonceKey(9n)).toBe(BigInt(keccak256(concat([keccak256(toBytes("vajra.unshield.v1")), word]))));
  });

  it("keeps recovery and unshield on separate nonce keys", () => {
    expect(recoveryNonceKey(9n, root)).not.toBe(unshieldNonceKey(9n));
  });

  it("gives a note one nonce key, whoever it pays", () => {
    const pay = (to: typeof recipient) => unshieldTx({ account, root: 5n, nullifierHash: 9n, recipient: to, proof, work: 0n }).nonceKeys;
    expect(pay(recipient)).toEqual(pay(account));
  });

  it("sends the SENDER frame exactly the gas the contract pins", () => {
    const frames = [recoveryTx({ account, newRoot: root, nullifier: 9n, proof, ticket: root }), unshieldTx({ account, root: 5n, nullifierHash: 9n, recipient, proof, work: 0n })].map((tx) => tx.frames[1]!);
    expect(frames[0]!.limits).toMatchObject(PROOF_FRAME_GAS.recovery);
    expect(frames[1]!.limits).toMatchObject(PROOF_FRAME_GAS.unshield);
  });

  it("is the same bytes every time, so a retry reveals nothing and cannot race itself", () => {
    const build = () => unshieldTx({ account, root: 5n, nullifierHash: 9n, recipient, proof, work: 0n });
    expect(encodeTx(build())).toBe(encodeTx(build()));
    expect(txHash(build())).toBe(txHash(build()));
  });

  it("carries the unshield's arguments at the offsets the contract reads", () => {
    const data = opsV2.unshield(5n, 9n, recipient).data;
    expect(data.length).toBe(2 + 2 * 100);
    expect(BigInt(`0x${data.slice(10, 74)}`)).toBe(5n);
    expect(BigInt(`0x${data.slice(74, 138)}`)).toBe(9n);
    expect(BigInt(`0x${data.slice(138, 202)}`)).toBe(BigInt(recipient));
  });

  it("carries the recovery's arguments at the offsets the contract reads", () => {
    const data = opsV2.queueRecovery(root, 9n).data;
    expect(data.length).toBe(2 + 2 * 68);
    expect(`0x${data.slice(10, 74)}`).toBe(root);
    expect(BigInt(`0x${data.slice(74, 138)}`)).toBe(9n);
  });

  it("puts a note's value in the frame, since shield is payable", () => {
    expect(opsV2.shield(1n, 10n).value).toBe(10n);
  });
});

describe("refusal names", () => {
  it.each(["RecoveryProofInvalid", "ShieldProofInvalid", "ProofTxShapeInvalid", "ValueNotConserved", "PoolClosed"])("names %s", (errorName) => {
    const data = encodeErrorResult({ abi: accountV2Abi as never, errorName } as never);
    expect(refusalNameV2(`validation frame 0: reverted with data ${data}`)).toBe(errorName);
  });

  it("names a refusal that has arguments", () => {
    const data = encodeErrorResult({ abi: accountV2Abi as never, errorName: "RootUnknown", args: [7n] } as never);
    expect(refusalNameV2(`validation frame 0: reverted with data ${data}`)).toBe("RootUnknown");
  });

  it("gives back a node's own message rather than inventing a name", () => {
    expect(refusalNameV2("prefix gas budget exceeded")).toBe("prefix gas budget exceeded");
    expect(refusalNameV2("reverted with data 0xdeadbeef")).toBe("reverted with data 0xdeadbeef");
  });
});

describe("releasing a queued payment", () => {
  const item = { id: 3n, recipient, asset: ETH, amount: 10n };

  it("ties the veto to the payment, so a failed veto cannot pay twice", () => {
    const [veto, pay] = releaseCalls(item);
    expect(veto!.atomic).toBe(true);
    expect(pay!.atomic).toBeUndefined();
  });

  it("sends the flag on the wire, and leaves it off the last frame, where it would be invalid", () => {
    const tx = masterTx({ account, root, leaf: 0, calls: releaseCalls(item) });
    expect(tx.frames[1]!.flags).toBe(ATOMIC_BATCH_FLAG);
    expect(tx.frames[2]!.flags).toBe(0);
  });

  it("sends exactly what was queued, to who it was queued for", () => {
    const [, pay] = releaseCalls(item);
    expect(pay!.target).toBe(recipient);
    expect(pay!.value).toBe(10n);
  });

  it("pays a token through the token, with no value", () => {
    const token = "0x3333333333333333333333333333333333333333" as const;
    const [, pay] = releaseCalls({ ...item, asset: token });
    expect(pay!.target).toBe(token);
    expect(pay!.value).toBeUndefined();
    expect(pay!.data.startsWith("0xa9059cbb")).toBe(true);
  });
});
