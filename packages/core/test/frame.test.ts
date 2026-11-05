import { afterEach, describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { DEVNET, setRpcFetch } from "../src/devnet.ts";
import { MAX_VERIFY_GAS, STEALTH_LIMITS, dailyTx, leafNonceKey, masterTx, refusalName, sendAlt, sigHash, stealthTx, walletMessage, withMasterSignature } from "../src/frame.ts";

const account = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222" as const;
const root = keccak256(toHex("root"));
const call = (data: `0x${string}`) => ({ data, execution: 1n, state: 1n });
const spend = dailyTx({ account, dailyKey: other, nonce: 1n, calls: [call("0x1234")] });

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => setRpcFetch((...args) => fetch(...args)));

describe("budgets", () => {
  it("a master transaction declares exactly what fits under the cap", () => {
    const tx = masterTx({ account, root, leaf: 0, calls: [] });
    expect(tx.frames[0]!.limits.execution + 100n).toBe(MAX_VERIFY_GAS);
  });

  it("a stealth prefix, with both signature costs, fits under the cap", () => {
    expect(STEALTH_LIMITS.verify + STEALTH_LIMITS.pay + 100n + 2800n).toBeLessThanOrEqual(MAX_VERIFY_GAS);
  });

  it("a stealth spend runs leaf N on nonce N + 1", () => {
    const tx = stealthTx({ account, leaf: 4, paymaster: other, coSigner: other, calls: [] });
    expect(tx.nonceSeq).toBe(5n);
    expect(tx.nonceKeys).toEqual([0n]);
  });
});

describe("nonce keys", () => {
  it("differ by leaf and by tree", () => {
    expect(leafNonceKey(root, 0)).not.toBe(leafNonceKey(root, 1));
    expect(leafNonceKey(root, 0)).not.toBe(leafNonceKey(keccak256(toHex("next tree")), 0));
  });

  it("are never the account's linear nonce", () => {
    expect(leafNonceKey(root, 0)).not.toBe(0n);
  });
});

describe("the signature hash", () => {
  it("does not depend on the master signature, which is what lets it be signed at all", () => {
    const tx = masterTx({ account, root, leaf: 0, calls: [] });
    expect(sigHash(withMasterSignature(tx, "0xabcd"))).toBe(sigHash(tx));
  });

  it("depends on every frame", () => {
    const a = masterTx({ account, root, leaf: 0, calls: [call("0x01")] });
    const b = masterTx({ account, root, leaf: 0, calls: [call("0x02")] });
    expect(sigHash(a)).not.toBe(sigHash(b));
  });
});

describe("walletMessage", () => {
  const changed = (calls = [call("0x1234")], nonce = 1n, fee?: bigint) =>
    walletMessage(dailyTx({ account, dailyKey: other, nonce, calls, fees: fee ? { maxFeePerGas: fee } : undefined }));

  it("changes with the call, the nonce and the fee", () => {
    const base = walletMessage(spend);
    expect(changed([call("0x5678")])).not.toBe(base);
    expect(changed(undefined, 2n)).not.toBe(base);
    expect(changed(undefined, 1n, 7n)).not.toBe(base);
  });

  it("refuses any shape it cannot fully cover", () => {
    const two = dailyTx({ account, dailyKey: other, nonce: 1n, calls: [call("0x01"), call("0x02")] });
    expect(() => walletMessage(two)).toThrow();
  });
});

describe("refusalName", () => {
  it("names an account error", () => {
    expect(refusalName("validation frame 0: reverted with data 0x552afea0")).toBe("AccountFrozen");
  });

  it("leaves anything else as the node said it", () => {
    expect(refusalName("Invalid Transaction: Nonce mismatch")).toBe("Invalid Transaction: Nonce mismatch");
  });
});

describe("sendAlt", () => {
  const tx = masterTx({ account, root, leaf: 0, calls: [] });

  it("uses the miner's sidecar first", async () => {
    const urls: string[] = [];
    setRpcFetch(async (url) => {
      urls.push(String(url));
      return respond(200, { result: "0xabc" });
    });
    await expect(sendAlt(tx)).resolves.toBe("0xabc");
    expect(urls).toEqual([DEVNET.mempool]);
  });

  it("falls back to the gateway when the miner cannot be reached", async () => {
    const urls: string[] = [];
    setRpcFetch(async (url) => {
      urls.push(String(url));
      if (url === DEVNET.mempool) throw new TypeError("fetch failed");
      return respond(200, { result: "0xdef" });
    });
    await expect(sendAlt(tx)).resolves.toBe("0xdef");
    expect(urls).toEqual([DEVNET.mempool, DEVNET.gateway]);
  });

  it("does not shop a refusal around to another node", async () => {
    const urls: string[] = [];
    setRpcFetch(async (url) => {
      urls.push(String(url));
      return respond(200, { error: { code: -32602, message: "validation frame 0: reverted" } });
    });
    await expect(sendAlt(tx)).rejects.toThrow("reverted");
    expect(urls).toEqual([DEVNET.mempool]);
  });
});
