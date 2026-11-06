import { afterEach, describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";
import { explain, simulate } from "../src/admission.ts";
import { setRpcFetch } from "../src/devnet.ts";
import { type FrameTx, dailyTx } from "../src/frame.ts";
import { quotaPaymasterAbi } from "../src/paymaster.ts";

const account = "0x000000000000000000000000000000000000dEaD";
const tx: FrameTx = dailyTx({ account, dailyKey: account, nonce: 0n, calls: [{ data: "0x", execution: 1n, state: 0n }] });

type Answer = unknown | { error: { code: number; message: string } };

/** A node that knows only these methods. Anything else is a JSON-RPC "method not found". */
function node(answers: Record<string, Answer>) {
  setRpcFetch(async (_url, init) => {
    const { id, method } = JSON.parse(init!.body as string);
    const answer = answers[method];
    const body = answer === undefined ? { error: { code: -32601, message: `Method ${method} is not supported` } } : (answer as { error?: unknown }).error ? (answer as object) : { result: answer };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { status: 200 });
  });
}

afterEach(() => setRpcFetch((...args) => fetch(...args)));

const refusedBySimulator = {
  canonicalMempoolValid: false,
  canonicalMempoolViolation: "StorageReadNonSender",
  maxCost: "0x1",
  frames: null,
  gasUsed: null,
  payer: null,
  prefixShape: "OnlyVerifyPay",
  executionStatus: null,
  executionError: null,
};

describe("simulate", () => {
  it("names the canonical rule and the fix", async () => {
    node({ ethrex_simulateFrameTransaction: refusedBySimulator });
    const { canonical } = await simulate(tx);
    expect(canonical).toMatchObject({ admitted: false, rule: "StorageReadNonSender", source: "ethrex" });
    expect(canonical.fix).toMatch(/alt mempool/);
  });

  it("decodes our own refusal", async () => {
    const data = encodeErrorResult({ abi: quotaPaymasterAbi, errorName: "NotEnrolled", args: [account] });
    node({ ethrex_simulateFrameTransaction: { ...refusedBySimulator, canonicalMempoolViolation: "validation prefix frame reverted", revertData: data } });
    const { canonical } = await simulate(tx);
    expect(canonical.refusal).toBe("NotEnrolled");
    expect(canonical.fix).toMatch(/enrolled/);
  });

  it("gives no rule and no advice for words it does not know", async () => {
    node({ ethrex_simulateFrameTransaction: { ...refusedBySimulator, canonicalMempoolViolation: "a violation nobody has seen" } });
    const { canonical } = await simulate(tx);
    expect(canonical).toMatchObject({ admitted: false, rule: null, fix: null, reason: "a violation nobody has seen" });
  });

  it("keeps a node that cannot be reached unknown, on both", async () => {
    setRpcFetch(async () => {
      throw new Error("connection refused");
    });
    const { canonical, alt } = await simulate(tx);
    expect(canonical.admitted).toBeNull();
    expect(alt.admitted).toBeNull();
  });

  it("does not claim an alt verdict it cannot reach off the mirror", async () => {
    node({ ethrex_simulateFrameTransaction: refusedBySimulator, eth_estimateFrameTransactionGas: { error: { code: -32507, message: "Invalid frame transaction signature" } } });
    const { alt } = await simulate(tx);
    expect(alt.admitted).toBeNull();
    expect(alt.unverified.length).toBeGreaterThan(0);
  });

  it("takes the sidecar's word on the prefix", async () => {
    node({ ethrex_simulateFrameTransaction: refusedBySimulator, eth_estimateFrameTransactionGas: { error: { code: -32602, message: "frame transaction validation prefix not recognized" } } });
    const { alt } = await simulate(tx);
    expect(alt).toMatchObject({ admitted: false, rule: "prefix", source: "sidecar" });
  });
});

describe("explain", () => {
  const hash = `0x${"ab".repeat(32)}` as const;

  it("says unknown when nobody knows the transaction", async () => {
    node({ eth_getTransactionReceipt: null, eth_getTransactionByHash: null });
    const told = await explain(hash);
    expect(told).toMatchObject({ state: "unknown", block: null, gasUsed: null, checks: null, explorer: false, frames: [] });
    expect(told.alt.admitted).toBeNull();
    expect(told.canonical.admitted).toBeNull();
  });

  it("reports a refusal from the sidecar's record, with the name and the rule", async () => {
    const data = encodeErrorResult({ abi: quotaPaymasterAbi, errorName: "OverQuota", args: [account, 2n, 1n] });
    node({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: null,
      skandha_explorer_getTransaction: {
        hash,
        entry: null,
        events: [],
        admission: {
          outcome: "rejected",
          sender: account,
          checks: [
            { rule: "prefix", verdict: "pass" },
            { rule: "simulation", verdict: "fail", detail: `validation frame 2: reverted with data ${data}` },
          ],
          frames: [{ mode: 1, target: null }],
          frameStatuses: ["not-run"],
        },
      },
    });
    const told = await explain(hash);
    expect(told.state).toBe("rejected");
    expect(told.alt).toMatchObject({ admitted: false, rule: "simulation", refusal: "OverQuota", source: "explorer" });
    expect(told.alt.fix).toMatch(/quota/);
    expect(told.canonical.admitted).toBeNull();
    expect(told.frames[0]).toMatchObject({ mode: "VERIFY", status: "not-run", gasUsed: null, stateGasUsed: null });
  });

  it("does not turn a missing explorer record into a verdict about rules", async () => {
    node({
      eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x10", gasUsed: "0x5208", frameReceipts: [{ status: "0x1", gasUsed: "0x5208", stateGasUsed: "0x0", logs: [] }] },
      eth_getTransactionByHash: { blockNumber: "0x10", chainId: "0x539", frames: [{ mode: "0x1", flags: "0x3", to: null, gasLimit: "0x1", stateLimit: "0x0", value: "0x0", data: "0x" }] },
    });
    const told = await explain(hash);
    expect(told).toMatchObject({ state: "mined", block: 16, gasUsed: 21000n, explorer: false, checks: null });
    expect(told.alt).toMatchObject({ admitted: true, source: "chain" });
    expect(told.alt.unverified.length).toBeGreaterThan(0);
    expect(told.canonical.admitted).toBeNull();
  });
});
