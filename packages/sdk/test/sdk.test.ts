import { createPublicClient, custom } from "viem";
import { describe, expect, it } from "vitest";
import { ChainMismatch, escapeStatus, explain, vajraActions, vajraChain } from "../src/index.ts";

const answering = (answers: Record<string, unknown>) =>
  createPublicClient({
    chain: vajraChain,
    transport: custom({
      request: async ({ method }) => {
        if (!(method in answers)) throw new Error(`no answer for ${method}`);
        return answers[method];
      },
    }),
  });

describe("the actions", () => {
  it("are all on an extended client", () => {
    const client = answering({}).extend(vajraActions());
    for (const name of ["simulate", "send", "explain", "spend", "veto", "escapeStatus"] as const) expect(client[name]).toBeTypeOf("function");
  });

  it("refuse a client on another chain", () => {
    const other = createPublicClient({ chain: { ...vajraChain, id: 1 }, transport: custom({ request: async () => null }) });
    expect(() => explain(other, { hash: "0x00" })).toThrow(ChainMismatch);
  });

  it("say unknown when a node will not answer a log query", async () => {
    const client = answering({
      eth_call: `0x${"0".repeat(63)}1`,
      eth_getBalance: "0x5",
      eth_blockNumber: "0x1",
    });
    const status = await escapeStatus(client, { account: "0x000000000000000000000000000000000000dEaD" });
    expect(status.frozen).toBe(true);
    expect(status.escaped).toBeNull();
    expect(status.harbor).toBeNull();
  });
});
