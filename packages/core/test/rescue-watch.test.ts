/**
 * What the watcher and the page decide, against a node that answers from a plain object. Everything here is a mock: `vajra nominee-e2e` is
 * the same ground on a real chain. These cover what a real chain cannot be made to do on demand: 150,000 waiting items, a node that lies
 * about itself, a sidecar that takes a transaction and sits on it.
 */
import { type Hex, encodeEventTopics, encodeFunctionResult, decodeFunctionData, keccak256, parseAbiItem, toFunctionSelector, toHex, zeroAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MasterSigner,
  RPC_TIMEOUT_MS,
  WOTS_W16,
  accountV2Abi,
  checkRescue,
  exitAbi,
  harborCommitment,
  memoryStore,
  parseRescue,
  rescueDue,
  rescueFile,
  rpc,
  sendAtFrom,
  sendRescue,
  setRpcFetch,
  signRescue,
  timeToSend,
  wouldBurn,
} from "../src/index.ts";

const account = "0x1111111111111111111111111111111111111111" as const;
const exit = "0x2222222222222222222222222222222222222222" as const;
const harbor = "0x3333333333333333333333333333333333333333" as const;
const payee = "0x4444444444444444444444444444444444444444" as const;
const harborSalt = keccak256(toHex("harbor"));
const epochSalt = keccak256(toHex("epoch"));
const genesis = keccak256(toHex("genesis"));
const WAITING = 1;

const escaped = parseAbiItem("event Escaped(address indexed harbor)");

/** Building the tree is most of the cost here, and every test can share one. */
const signer = new MasterSigner(WOTS_W16, memoryStore(), () => new Uint8Array(32).fill(5));
const { tx: signed } = signRescue({ signer, exit, account, epochSalt, harbor, harborSalt, tokens: 0 });
const aRescue = (marginSeconds = 15) => ({ tx: signed, rescue: parseRescue(rescueFile({ tx: signed, genesis, marginSeconds })) });

interface World {
  items: number;
  recipientOf: (id: number) => Hex;
  executeAfter: (id: number) => bigint;
  frozen: boolean;
  recovery: Set<number>;
  now: bigint;
  delay: bigint;
  namedExit: Hex;
  commitment: Hex;
  root: Hex;
  reserve: bigint;
  genesis: Hex;
  receipt: unknown;
  simulate: () => unknown;
  logs: () => unknown[];
  asked: Record<string, number>;
}

const healthy = () => ({ canonicalMempoolValid: true, frames: [{ gasUsed: "0x17b42", succeeded: true }, { gasUsed: "0x10000", succeeded: true }], gasUsed: "0x20000", executionError: null, maxCost: "0x1" });

function world(over: Partial<World> = {}): World {
  return {
    items: 0,
    recipientOf: () => payee,
    executeAfter: () => 1000n,
    frozen: false,
    recovery: new Set(),
    now: 900n,
    delay: 86_400n,
    namedExit: exit,
    commitment: harborCommitment(harbor, harborSalt),
    root: signer.root,
    reserve: 10n ** 18n,
    genesis,
    receipt: null,
    simulate: healthy,
    logs: () => [],
    asked: {},
    ...over,
  };
}

const QUEUED_ITEM = toFunctionSelector("queuedItem(uint256)");

function answer(w: World, memo: Map<string, Hex>, call: { method: string; params: any[] }): unknown {
  const count = (name: string) => (w.asked[name] = (w.asked[name] ?? 0) + 1);
  count(call.method);
  switch (call.method) {
    case "eth_getBalance":
      return call.params[0].toLowerCase() === exit ? `0x${w.reserve.toString(16)}` : "0x1";
    case "eth_getTransactionReceipt":
      return w.receipt;
    case "eth_getLogs":
      return w.logs();
    case "eth_getBlockByNumber":
      if (call.params[0] === "0x0") return { hash: w.genesis };
      return { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: `0x${w.now.toString(16)}`, baseFeePerGas: "0x7", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: zeroAddress, logsBloom: `0x${"00".repeat(256)}`, transactions: [], uncles: [], difficulty: "0x0", extraData: "0x", nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, size: "0x0" };
    case "ethrex_simulateFrameTransaction":
      return w.simulate();
    case "eth_call": {
      const { to, data } = call.params[0] as { to: string; data: Hex };
      // A flood is 150,000 of these, so it stays off the slow path.
      if (data.startsWith(QUEUED_ITEM)) {
        const id = Number(BigInt(`0x${data.slice(10)}`));
        count("queuedItem");
        const recipient = w.recipientOf(id);
        const executeAfter = w.executeAfter(id);
        const key = `${recipient}:${executeAfter}`;
        let encoded = memo.get(key);
        if (!encoded) {
          encoded = encodeFunctionResult({ abi: accountV2Abi as never, functionName: "queuedItem", result: { recipient, asset: zeroAddress, amount: 1n, executeAfter, state: WAITING } } as never) as Hex;
          memo.set(key, encoded);
        }
        return encoded;
      }
      const abi = (to.toLowerCase() === exit ? exitAbi : accountV2Abi) as never;
      const { functionName, args } = decodeFunctionData({ abi, data }) as { functionName: string; args?: readonly unknown[] };
      count(functionName);
      const encode = (result: unknown) => encodeFunctionResult({ abi, functionName, result } as never);
      switch (functionName) {
        case "dailyKey":
          return encode(zeroAddress);
        case "frozen":
          return encode(w.frozen);
        case "nextItem":
          return encode(BigInt(w.items));
        case "rule":
          return encode([true, 1n, 1n, 0n]);
        case "exit":
          return encode(w.namedExit);
        case "harborCommitment":
          return encode(w.commitment);
        case "root":
          return encode(w.root);
        case "queueDelay":
          return encode(w.delay);
        case "isRecovery":
          return encode(w.recovery.has(Number(args![0])));
        default:
          throw new Error(`mock: nothing for ${functionName}`);
      }
    }
    default:
      throw new Error(`mock: nothing for ${call.method}`);
  }
}

function serve(w: World, sidecar?: typeof fetch) {
  const memo = new Map<string, Hex>();
  const one = (call: { id: number; method: string; params: any[] }) => {
    try {
      return { jsonrpc: "2.0", id: call.id, result: answer(w, memo, call) };
    } catch (error) {
      const e = error as { code?: number; message: string };
      if (typeof e.code === "number") return { jsonrpc: "2.0", id: call.id, error: { code: e.code, message: e.message } };
      throw error;
    }
  };
  const node = (async (_url: string, init: RequestInit) => {
    // As a real fetch does. Without this a flood is one long chain of microtasks, and the worker cannot answer vitest.
    await new Promise((resolve) => setImmediate(resolve));
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  setRpcFetch(node, { sidecar: sidecar ?? node });
}

const refusing = (code: number, message: string) => () => {
  throw { code, message };
};

afterEach(() => setRpcFetch((...args) => fetch(...args)));

describe("a thief who floods the queue", () => {
  // `Math.min(...items)` threw past about 125,000 items, every poll, and the watcher only said "state unknown".
  it(
    "still finds the soonest item, past where a spread overflows",
    async () => {
      serve(world({ items: 150_000, executeAfter: (id) => 1000n + BigInt(id), now: 990n }));
      const due = await rescueDue(aRescue().rescue);
      expect(due.waiting).toHaveLength(150_000);
      expect(due.soonest).toBe(1000);
      expect(due.due).toBe(true);
    },
    120_000,
  );

  // Each read was its own request, all at once, so a flood kept from before a freeze would have failed exactly when a recovery came.
  it("asks about recoveries only for items with no recipient, on a frozen account", async () => {
    const w = world({ items: 5_000, frozen: true, recipientOf: (id) => (id < 3 ? zeroAddress : payee), recovery: new Set([1]), executeAfter: () => 1000n, now: 990n });
    serve(w);
    const due = await rescueDue(aRescue().rescue);
    expect(w.asked.isRecovery).toBe(3);
    expect(due.waiting.map((item) => item.id)).toEqual([1n]);
    expect(due.due).toBe(true);
  });

  it("does not count a spend on a frozen account, even one with no recipient", async () => {
    serve(world({ items: 1, frozen: true, recipientOf: () => zeroAddress, now: 990n }));
    const due = await rescueDue(aRescue().rescue);
    expect(due.waiting).toHaveLength(0);
    expect(due.due).toBe(false);
  });
});

describe("the margin, which is not signed", () => {
  const item = { items: 1, executeAfter: () => 86_500n, now: 101n };

  it("refuses a file with a margin of nothing", () => {
    const { tx } = aRescue();
    expect(() => parseRescue(rescueFile({ tx, genesis, marginSeconds: 0 }))).toThrow(/margin/);
  });

  // A lying file must not fire the moment anything queues, before the owner has had any time to answer.
  it("falls back to the default for a margin as long as the delay", async () => {
    serve(world(item));
    const due = await rescueDue(aRescue(9_007_199_254_740_991).rescue);
    expect(due.margin).toBe(3600);
    expect(due.due).toBe(false);
  });

  // `--margin 1h` was Number("1h"), so `sendIn` was NaN, `due` stayed false, and the rescue never went.
  it("is never NaN", async () => {
    serve(world({ ...item, now: 86_499n }));
    const due = await rescueDue(aRescue().rescue, Number("1h"));
    expect(due.margin).toBe(3600);
    expect(due.due).toBe(true);
  });
});

describe("whether it would work", () => {
  const { rescue, tx } = aRescue();

  it("says ready when it would", async () => {
    serve(world());
    expect((await checkRescue(rescue)).state).toBe("ready");
  });

  // Only the node's verdict on this transaction counts. These say nothing about it, and calling them broken meant no rescue went.
  for (const [what, code, message] of [
    ["a proxy blocking the method", -32601, "Method not found"],
    ["an error inside the node", -32603, "Internal error"],
  ] as const) {
    it(`does not call ${what} broken`, async () => {
      serve(world({ simulate: refusing(code, message) }));
      const check = await checkRescue(rescue);
      expect(check.state).toBe("unknown");
      expect(wouldBurn(check)).toBe(false);
    });
  }

  it("still tries what the node refuses, because a refusal is free", async () => {
    serve(world({ simulate: refusing(-32015, "rate limit exceeded") }));
    const check = await checkRescue(rescue);
    expect(check.state).toBe("broken");
    expect(wouldBurn(check)).toBe(false);
  });

  it("does not let a forged genesis stop a rescue", async () => {
    serve(world());
    const forged = parseRescue(rescueFile({ tx, genesis: keccak256(toHex("not this chain")), marginSeconds: 15 }));
    const check = await checkRescue(forged);
    expect(check.state).toBe("broken");
    expect(wouldBurn(check)).toBe(false);
  });

  it("still tries with a reserve that is short, since someone can top it up", async () => {
    serve(world({ reserve: 1n }));
    const check = await checkRescue(rescue);
    expect(check.state).toBe("broken");
    expect(wouldBurn(check)).toBe(false);
  });

  it("holds back only what would mine, fail, and spend the nonce key", async () => {
    serve(world({ simulate: () => ({ ...healthy(), frames: [{ gasUsed: "0x1", succeeded: true }, { gasUsed: "0x1", succeeded: false }], executionError: "HarborMismatch" }) }));
    expect(wouldBurn(await checkRescue(rescue))).toBe(true);
    serve(world({ commitment: keccak256(toHex("moved")) }));
    expect(wouldBurn(await checkRescue(rescue))).toBe(true);
    serve(world({ namedExit: payee }));
    expect(wouldBurn(await checkRescue(rescue))).toBe(true);
  });
});

describe("a nonce key that has been spent", () => {
  const { rescue } = aRescue();
  const spent = refusing(-32000, "Nonce mismatch: expected 1, got 0");
  const landed = "0x7777777777777777777777777777777777777777777777777777777777777777" as const;
  const log = () => [{ address: account, topics: encodeEventTopics({ abi: [escaped], args: { harbor } }), data: "0x", blockNumber: "0x2a", transactionHash: landed, transactionIndex: "0x0", blockHash: `0x${"11".repeat(32)}`, logIndex: "0x0", removed: false }];

  // A padded copy has another hash and did the job, so the chain has to say so.
  it("is sent, if the money really reached the harbor", async () => {
    serve(world({ simulate: spent, logs: log }));
    const check = await checkRescue(rescue);
    expect(check).toMatchObject({ state: "sent", hash: landed, block: 42, succeeded: true, copy: true });
  });

  // A restored signer can spend the same leaf on a veto. The node only checks the key, so the watcher used to stop and the page said "Rescued".
  it("is not sent, if nothing reached the harbor", async () => {
    serve(world({ simulate: spent }));
    const check = await checkRescue(rescue);
    expect(check.state).toBe("broken");
  });

  it("is unknown, if the chain will not say", async () => {
    serve(world({ simulate: spent, logs: () => { throw { code: -32603, message: "too many blocks" }; } }));
    expect((await checkRescue(rescue)).state).toBe("unknown");
  });
});

describe("sending it", () => {
  const { rescue } = aRescue();
  const reply = (id: number, body: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { headers: { "content-type": "application/json" } });

  /** A node that takes the bytes and mines them, behind a sidecar that behaves as told. */
  async function through(sidecar: typeof fetch, timeoutMs = 400) {
    const w = world();
    let canonical = 0;
    const node = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "eth_sendRawTransaction") {
        canonical++;
        w.receipt = { status: "0x1", blockNumber: "0x2a", gasUsed: "0x1", frameReceipts: [{ status: "0x1", gasUsed: "0x1", stateGasUsed: "0x0", logs: [] }] };
        return reply(body.id, { result: rescue.hash });
      }
      return reply(body.id, { result: answer(w, new Map(), body) });
    }) as typeof fetch;
    setRpcFetch(node, { sidecar });
    const sent = await sendRescue(rescue, { timeoutMs });
    return { sent, canonical };
  }

  const answered = (result: (method: string) => unknown): typeof fetch =>
    (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return reply(body.id, { result: result(body.method) });
    }) as typeof fetch;

  it("goes to the canonical mempool when the sidecar refuses it", async () => {
    const { sent, canonical } = await through((async (_u: string, init: RequestInit) => reply(JSON.parse(init.body as string).id, { error: { code: -32602, message: "refused" } })) as typeof fetch);
    expect(canonical).toBe(1);
    expect(sent.route).toBe("canonical");
  });

  it("goes there when the sidecar cannot be reached", async () => {
    const { sent, canonical } = await through((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(canonical).toBe(1);
    expect(sent.route).toBe("canonical");
  });

  it("goes there when the sidecar answers with a bad gateway", async () => {
    const { canonical } = await through((async () => new Response("bad gateway", { status: 502 })) as typeof fetch);
    expect(canonical).toBe(1);
  });

  it(
    "goes there when the sidecar takes it and never relays it",
    async () => {
      const { sent, canonical } = await through(answered((method) => (method === "skandha_frameTransactionStatus" ? { status: "Pending" } : rescue.hash)));
      expect(canonical).toBe(1);
      expect(sent.route).toBe("canonical");
    },
    20_000,
  );

  it("waits for it when the canonical mempool already has it", async () => {
    const w = world();
    const node = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "eth_sendRawTransaction") {
        w.receipt = { status: "0x1", blockNumber: "0x2a", gasUsed: "0x1", frameReceipts: [{ status: "0x1", gasUsed: "0x1", stateGasUsed: "0x0", logs: [] }] };
        return reply(body.id, { error: { code: -32000, message: "already known" } });
      }
      return reply(body.id, { result: answer(w, new Map(), body) });
    }) as typeof fetch;
    setRpcFetch(node, { sidecar: (async () => new Response("down", { status: 502 })) as typeof fetch });
    expect((await sendRescue(rescue, { timeoutMs: 400 })).route).toBe("canonical");
  });
});

describe("what a failed read means at the moment it matters", () => {
  const ready = { state: "ready", reserve: 1n, maxCost: 1n, verifyGas: 1, totalGas: 1 } as const;
  const unknown = { state: "unknown", reason: "no answer" } as const;
  const burns = { state: "broken", reason: "the harbor moved", burns: true } as const;
  const free = { state: "broken", reason: "short", burns: false } as const;
  const due = (sendIn: number | null) => ({ now: 0, frozen: false, waiting: [], soonest: null, sendIn, due: sendIn !== null && sendIn <= 0, margin: 15, staleBy: 0 });

  it("goes when the read says so", () => {
    expect(timeToSend({ check: ready, due: due(0), lastSendAt: null })).toBe(true);
    expect(timeToSend({ check: ready, due: due(10), lastSendAt: null })).toBe(false);
  });

  it("goes on a check that is only unknown, or refused for free", () => {
    expect(timeToSend({ check: unknown, due: due(0), lastSendAt: null })).toBe(true);
    expect(timeToSend({ check: free, due: due(0), lastSendAt: null })).toBe(true);
  });

  it("never sends what would burn the nonce key", () => {
    expect(timeToSend({ check: burns, due: due(0), lastSendAt: 0 })).toBe(false);
    expect(timeToSend({ check: burns, due: null, lastSendAt: 0 }, 1000)).toBe(false);
  });

  // An item was waiting, its time came, and the chain stopped answering. A rescue nobody needed costs a frozen account. A theft costs everything.
  it("goes on the last good read, when the chain stops answering at the margin", () => {
    expect(timeToSend({ check: unknown, due: null, lastSendAt: 5000 }, 5000)).toBe(true);
    expect(timeToSend({ check: unknown, due: null, lastSendAt: 5000 }, 4999)).toBe(false);
  });

  it("does not go on a failed read with nothing known to be waiting", () => {
    expect(timeToSend({ check: unknown, due: null, lastSendAt: null }, 5000)).toBe(false);
  });

  it("works out when, from what the chain said, and not from this machine's date", () => {
    expect(sendAtFrom(due(30), 1000)).toBe(31_000);
    expect(sendAtFrom(due(null), 1000)).toBe(null);
  });
});

describe("a node that does not answer", () => {
  // `rpc` had no timeout, so a page stuck on one read went on showing "Ready".
  // Fires the real timer by hand. A fake clock would also run vitest's own timers, which it keeps to talk to its workers.
  it("fails, and does not hang", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      setRpcFetch((() => new Promise(() => {})) as typeof fetch);
      const read = rpc("http://127.0.0.1:1", "eth_blockNumber");
      const seen = expect(read).rejects.toThrow(/no answer/);
      const expire = timers.mock.calls.find(([, ms]) => ms === RPC_TIMEOUT_MS)?.[0] as () => void;
      expire();
      await seen;
    } finally {
      timers.mockRestore();
    }
  });
});

describe("a head that has stopped moving", () => {
  it("is called out, and does not stop the watch", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000)) - 600n;
    serve(world({ now }));
    const due = await rescueDue(aRescue().rescue);
    expect(due.staleBy).toBeGreaterThanOrEqual(600);
  });

  it("is quiet on a healthy chain", async () => {
    serve(world({ now: BigInt(Math.floor(Date.now() / 1000)) }));
    expect((await rescueDue(aRescue().rescue)).staleBy).toBe(0);
  });
});
