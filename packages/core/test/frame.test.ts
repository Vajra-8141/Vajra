import { afterEach, describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex } from "viem";
import { DEVNET, rpc, rpcBatch, setRpcFetch, withTimeout } from "../src/devnet.ts";
import { type Call, MAX_VERIFY_GAS, STEALTH_LIMITS, dailyTx, dailyTypedData, leafNonceKey, masterTx, maxGas, refusalName, sendAlt, sigHash, stealthTx, walletMessage, withMasterSignature, withTypedSignature } from "../src/frame.ts";
import { ETH, ops } from "../src/account.ts";

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

describe("dailyTypedData", () => {
  const to = "0x2222222222222222222222222222222222222222" as const;
  const typed = (calls: Call[]) => dailyTypedData(dailyTx({ account, dailyKey: other, nonce: 4n, calls }));

  it("shows the asset, the recipient and the amount", () => {
    const { primaryType, message, domain } = typed([ops.spend(ETH, to, 5n)]);
    expect(primaryType).toBe("DailySpend");
    expect(message).toMatchObject({ asset: ETH, recipient: to, amount: 5n, nonce: 4n });
    expect(domain.verifyingContract).toBe(account);
  });

  it("names a queued item by its id", () => {
    const { primaryType, message } = typed([ops.executeQueued(7n)]);
    expect(primaryType).toBe("DailyExecute");
    expect(message).toMatchObject({ id: 7n });
  });

  it("refuses anything a daily key has no business signing", () => {
    expect(() => typed([ops.freeze()])).toThrow();
    expect(() => typed([ops.spend(ETH, to, 1n), ops.spend(ETH, to, 2n)])).toThrow();
  });

  it("puts what was shown into the entry's msg", () => {
    const tx = dailyTx({ account, dailyKey: other, nonce: 4n, calls: [ops.spend(ETH, to, 5n)] });
    const signature = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as const;
    expect(withTypedSignature(tx, signature).signatures[0]!.msg).toBe(hashTypedData(dailyTypedData(tx) as never));
  });

  it("signs the VERIFY limit and the maximum cost", () => {
    const tx = dailyTx({ account, dailyKey: other, nonce: 4n, calls: [ops.spend(ETH, to, 5n)] });
    const { message } = dailyTypedData(tx);
    expect(message.verifyGas).toBe(tx.frames[0]!.limits.execution);
    expect(message.maxCost % tx.fees.maxFeePerGas).toBe(0n);
  });

  it("lands on the signed cost exactly, whatever zero bytes the signature holds", () => {
    const tx = dailyTx({ account, dailyKey: other, nonce: 4n, calls: [ops.spend(ETH, to, 5n)] });
    const { maxCost } = dailyTypedData(tx).message;
    for (const r of ["11".repeat(32), `00${"11".repeat(31)}`, `${"00".repeat(5)}${"11".repeat(27)}`]) {
      for (const v of ["1b", "1c"]) {
        const signed = withTypedSignature(tx, `0x${r}${"22".repeat(32)}${v}`);
        expect(maxGas(signed) * tx.fees.maxFeePerGas).toBe(maxCost);
        expect(dailyTypedData(signed).message.maxCost).toBe(maxCost);
      }
    }
  });

  it("gives the same message for a transaction already padded", () => {
    const tx = dailyTx({ account, dailyKey: other, nonce: 4n, calls: [ops.spend(ETH, to, 5n)] });
    const signed = withTypedSignature(tx, `0x${"00".repeat(4)}${"11".repeat(28)}${"22".repeat(32)}1b`);
    expect(signed.frames[0]!.data.length).toBeGreaterThan(tx.frames[0]!.data.length);
    expect(hashTypedData(dailyTypedData(signed) as never)).toBe(signed.signatures[0]!.msg);
  });
});

describe("maxGas", () => {
  const verify = dailyTx({ account, dailyKey: other, nonce: 0n, calls: [{ data: "0x", execution: 100n, state: 7n }] });

  it("adds what ethrex adds", () => {
    // 12,000 + 2 frames + a secp256k1 entry. Data: `validateDaily(3)`'s 36 bytes, the signer, and rlp([0]), rlp(0) = c1 80 80.
    const data = 4n * 16n + 31n * 4n + 16n + 20n * 16n + 3n * 16n;
    expect(maxGas(verify)).toBe(12_000n + 950n + 2_800n + data + 60_000n + 100n + 7n);
  });

  it("charges 12 less for a zero byte than for any other", () => {
    const pad = (byte: string) => ({ ...verify, frames: [{ ...verify.frames[0]!, data: `${verify.frames[0]!.data}${byte}` as const }, verify.frames[1]!] });
    expect(maxGas(pad("ff")) - maxGas(pad("00"))).toBe(12n);
  });

  it("takes the calldata floor when that is more", () => {
    const body = { data: `0x${"00".repeat(5_000)}` as const, execution: 0n, state: 7n };
    const tx = dailyTx({ account, dailyKey: other, nonce: 0n, calls: [body], verifyGas: 0n });
    const bytes = 36n + 5_000n + 20n + 3n;
    expect(maxGas(tx)).toBe(12_000n + 950n + 2_800n + bytes * 64n + 7n);
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

describe("rpcBatch", () => {
  const calls = [
    { method: "a", params: [] },
    { method: "b", params: [] },
  ];
  const echo = (shape: (ids: number[]) => unknown) =>
    setRpcFetch(async (_, init) => respond(200, shape((JSON.parse(init!.body as string) as { id: number }[]).map((c) => c.id))));

  it("puts results back in call order, whatever order the node answered in", async () => {
    echo(([a, b]) => [
      { id: b, result: "second" },
      { id: a, result: "first" },
    ]);
    await expect(rpcBatch("https://example.invalid", calls)).resolves.toEqual(["first", "second"]);
  });

  it("makes one request for the whole batch", async () => {
    let requests = 0;
    setRpcFetch(async (_, init) => {
      requests++;
      return respond(200, (JSON.parse(init!.body as string) as { id: number }[]).map((c) => ({ id: c.id, result: 1 })));
    });
    await rpcBatch("https://example.invalid", calls);
    expect(requests).toBe(1);
  });

  it("fails when any call fails, rather than returning a partial answer", async () => {
    echo(([a, b]) => [
      { id: a, result: "ok" },
      { id: b, error: { code: 3, message: "reverted" } },
    ]);
    await expect(rpcBatch("https://example.invalid", calls)).rejects.toThrow("reverted");
  });

  it("fails when the node leaves a call out", async () => {
    echo(([a]) => [{ id: a, result: "ok" }]);
    await expect(rpcBatch("https://example.invalid", calls)).rejects.toThrow("left this call out");
  });

  it("fails when the node does not answer as a batch", async () => {
    echo(() => ({ error: "no batches here" }));
    await expect(rpcBatch("https://example.invalid", calls)).rejects.toThrow("did not answer");
  });

  it("sends nothing for an empty batch", async () => {
    setRpcFetch(() => Promise.reject(new Error("should not be called")));
    await expect(rpcBatch("https://example.invalid", [])).resolves.toEqual([]);
  });
});

describe("withTimeout", () => {
  it("turns a read that never returns into a failure", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "the read")).rejects.toThrow("the read timed out");
  });

  it("leaves a read that returns alone", async () => {
    await expect(withTimeout(Promise.resolve(1), 1000, "the read")).resolves.toBe(1);
  });
});

describe("routing by destination", () => {
  const route = () => {
    const seen: string[] = [];
    const tag = (name: string): typeof fetch => async () => {
      seen.push(name);
      return respond(200, { result: "0x1" });
    };
    setRpcFetch(tag("private"), { sidecar: tag("direct") });
    return seen;
  };

  it("keeps chain reads on the private route", async () => {
    const seen = route();
    await rpc(DEVNET.execution, "eth_blockNumber");
    expect(seen).toEqual(["private"]);
  });

  it("sends mempool calls by the sidecar path", async () => {
    const seen = route();
    await rpc(DEVNET.mempool, "skandha_frameTransactionStatus", ["0x01"]);
    await rpc(DEVNET.gateway, "skandha_frameTransactionStatus", ["0x01"]);
    expect(seen).toEqual(["direct", "direct"]);
  });

  it("uses one path for everything when no sidecar path is given", async () => {
    const seen: string[] = [];
    setRpcFetch(async () => {
      seen.push("only");
      return respond(200, { result: "0x1" });
    });
    await rpc(DEVNET.execution, "a");
    await rpc(DEVNET.mempool, "b");
    expect(seen).toEqual(["only", "only"]);
  });
});
