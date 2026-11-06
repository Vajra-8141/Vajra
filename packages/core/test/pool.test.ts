import { afterEach, describe, expect, it } from "vitest";
import { type Address, type Hex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, numberToHex, parseAbiItem, toHex } from "viem";
import { RpcError, accountV2Abi, setRpcFetch } from "../src/index.ts";
import { type PoolFacts, poolMeter, poolWords, readPoolFacts } from "../src/pool.ts";

const account = "0x00c0ffee0000000000000000000000000000c0ff" as Address;
const friend = "0x1111111111111111111111111111111111111111" as Address;
const stranger = "0x2222222222222222222222222222222222222222" as Address;
const facts = (depositors: (Address | null)[], withdrawn = 0, closed = false, owed = 0): PoolFacts => ({ account, closed, depositors, withdrawn, owed });
const read = (f: PoolFacts) => {
  const meter = poolMeter(f);
  return { meter, words: poolWords(meter) };
};
const everything = (words: ReturnType<typeof read>["words"]) => [words.headline, ...words.shows, ...words.unknown, ...words.cannotShow].join(" ");

describe("the pool meter", () => {
  it("says an owner alone in their pool hides nothing, however many notes there are", () => {
    const { meter, words } = read(facts(Array(30).fill(account)));
    expect(meter.state).toBe("hides nothing");
    expect(meter.addresses).toBe(1);
    expect(words.headline).toContain("plainly yours");
  });

  it("does not count notes as people: thirty notes from two addresses is two", () => {
    const { meter, words } = read(facts([...Array(29).fill(friend), account]));
    expect(meter.state).toBe("hides little");
    expect(meter.addresses).toBe(2);
    expect(words.headline).toContain("at most 2 addresses");
    expect(words.shows.join(" ")).toContain("right about 29 times in 30");
  });

  it("counts an address once, whatever its case", () => {
    expect(poolMeter(facts([friend, friend.toUpperCase().replace("0X", "0x") as Address, account])).addresses).toBe(2);
  });

  it("marks which share is the account's own", () => {
    const { meter } = read(facts([account, friend, friend, stranger]));
    expect(meter.shares).toEqual([
      { address: friend, notes: 2, own: false },
      { address: account, notes: 1, own: true },
      { address: stranger, notes: 1, own: false },
    ]);
  });

  it("never turns an unknown sender into a smaller or a larger count", () => {
    const { meter, words } = read(facts([account, null, friend]));
    expect(meter.state).toBe("unknown");
    expect(meter.addresses).toBeNull();
    expect(meter.shares).toBeNull();
    expect(words.headline).toMatch(/^Unknown/);
    expect(words.unknown.join(" ")).toContain("the number of addresses is unknown");
    expect(everything(words)).not.toMatch(/\b0 addresses\b/);
  });

  it("tells an empty pool from an unread one, and from one every note has left", () => {
    expect(read(facts([])).words.headline).toContain("Nothing has been paid in");
    expect(read(facts([account, friend], 2)).words.headline).toContain("Every note has left");
    expect(read(facts([account, friend], 2)).meter.state).toBe("empty");
  });

  it("calls a pool closed after an escape, whatever it held", () => {
    const { meter, words } = read(facts([account, friend], 0, true));
    expect(meter.state).toBe("closed");
    expect(words.headline).toContain("harbor");
  });

  it("never says the pool hides you well, at any size", () => {
    const crowd = Array.from({ length: 5000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
    const { meter, words } = read(facts([account, ...crowd]));
    expect(meter.state).toBe("hides little");
    expect(everything(words)).not.toMatch(/\b(anonymous|private|safe|secure|well hidden|untraceable)\b/i);
  });

  it("always keeps the limits, in every state", () => {
    for (const f of [facts([]), facts([account]), facts([account, friend]), facts([account, null]), facts([account], 0, true)]) {
      const { words } = read(f);
      expect(words.cannotShow.join(" ")).toContain("different people");
      expect(words.cannotShow.join(" ")).toContain("Which note left");
      expect(words.shows.join(" ")).toContain("not that");
    }
  });

  it("says when a failed payment is still owed, and only then", () => {
    expect(read(facts([account, friend], 1, false, 1)).words.shows.join(" ")).toContain("1 payment failed, and the money is still held for that note");
    expect(read(facts([account, friend, friend], 2, false, 2)).words.shows.join(" ")).toContain("2 payments failed");
    expect(read(facts([account, friend], 1)).words.shows.join(" ")).not.toContain("failed");
  });

  it("states the ceiling as at most, never at least", () => {
    const { words } = read(facts([account, friend, stranger]));
    expect(words.headline).toContain("at most 3");
    expect(everything(words)).toContain("never at least");
    expect(words.headline).not.toMatch(/at least/);
  });
});

describe("reading a pool", () => {
  // Not the real fetch: a client's retries can outlive a test, and in a unit test the chain it names is the public one.
  afterEach(() => setRpcFetch((async () => new Response("", { status: 503 })) as unknown as typeof fetch));

  const DENOM = 10n ** 17n;
  const FEE = 5n * 10n ** 15n;
  const shieldedEvent = parseAbiItem("event Shielded(uint256 indexed commitment, uint256 leaf, uint256 root)");
  const paidEvent = parseAbiItem("event Unshielded(uint256 indexed nullifierHash, address indexed recipient)");
  const refusedEvent = parseAbiItem("event UnshieldUnpaid(uint256 indexed nullifierHash, address indexed recipient)");
  let nextTx = 1;

  /** A node. `count` and `held` are what the contract says, and `deposits`, `paid` and `refused` are what its logs say, so that they can disagree. */
  function node(o: { count: number; held: bigint; deposits: number; paid?: number; refused?: number; closed?: boolean; from?: Address | null; failLogs?: boolean; revert?: boolean; noCode?: boolean }) {
    const log = (topics: readonly unknown[], data: Hex = "0x") => ({ address: account, topics, data, blockNumber: "0x1", blockHash: keccak256(toHex("b")), transactionHash: numberToHex(nextTx++, { size: 32 }), transactionIndex: "0x0", logIndex: "0x0", removed: false });
    const answer = (method: string, params: { data?: Hex; topics?: Hex[] }[]) => {
      if (method === "eth_call") {
        if (o.noCode) return "0x";
        if (o.revert) throw Object.assign(new Error("execution reverted"), { rpc: true });
        const { functionName } = decodeFunctionData({ abi: accountV2Abi, data: params[0]!.data! }) as { functionName: string };
        const result = { noteCount: BigInt(o.count), poolClosed: !!o.closed, poolHeld: o.held, DENOMINATION: DENOM, MAX_PROOF_TX_COST: FEE }[functionName];
        return encodeFunctionResult({ abi: accountV2Abi, functionName, result } as never);
      }
      if (method === "eth_getLogs") {
        if (o.failLogs) throw new Error("query returned more than 10000 results");
        const topic = params[0]!.topics![0];
        const many = (n: number, make: (i: number) => ReturnType<typeof log>) => Array.from({ length: n }, (_, i) => make(i));
        if (topic === encodeEventTopics({ abi: [shieldedEvent] })[0]) return many(o.deposits, (i) => log(encodeEventTopics({ abi: [shieldedEvent], args: { commitment: BigInt(i + 1) } }), encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(i), 7n])));
        if (topic === encodeEventTopics({ abi: [paidEvent] })[0]) return many(o.paid ?? 0, (i) => log(encodeEventTopics({ abi: [paidEvent], args: { nullifierHash: BigInt(i + 1), recipient: friend } })));
        return many(o.refused ?? 0, (i) => log(encodeEventTopics({ abi: [refusedEvent], args: { nullifierHash: BigInt(i + 100), recipient: friend } })));
      }
      if (method === "eth_getTransactionByHash") return o.from === null ? null : { from: o.from ?? friend };
      throw new Error(`unexpected ${method}`);
    };
    const reply = (call: { id: number; method: string; params: never }) => {
      try {
        return { jsonrpc: "2.0", id: call.id, result: answer(call.method, call.params) };
      } catch (error) {
        return { jsonrpc: "2.0", id: call.id, error: { code: 3, message: (error as Error).message } };
      }
    };
    setRpcFetch((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "content-type": "application/json" } });
    }) as typeof fetch);
  }

  it("reads an honest pool, and works out what is owed from the money", async () => {
    node({ count: 3, held: DENOM + (DENOM - FEE), deposits: 3, paid: 1, refused: 1 });
    expect(await readPoolFacts(account)).toMatchObject({ withdrawn: 2, owed: 1 });
  });

  it("calls a pool whose log is short unknown, and gives no number", async () => {
    node({ count: 5, held: 5n * DENOM, deposits: 3 });
    await expect(readPoolFacts(account)).rejects.toThrow("chain state unknown");
  });

  it("calls it unknown when the withdrawals in the log do not add up to what it holds", async () => {
    node({ count: 3, held: 3n * DENOM, deposits: 3, paid: 1 });
    await expect(readPoolFacts(account)).rejects.toThrow("chain state unknown");
    node({ count: 3, held: DENOM, deposits: 3, paid: 1 });
    await expect(readPoolFacts(account)).rejects.toThrow("chain state unknown");
  });

  it("owes nothing on bytes with no claims, where a refused payment is simply gone", async () => {
    node({ count: 2, held: DENOM, deposits: 2, refused: 1 });
    expect(await readPoolFacts(account)).toMatchObject({ withdrawn: 1, owed: 0 });
  });

  it("owes nothing once an escape has closed the pool", async () => {
    node({ count: 2, held: 0n, deposits: 2, refused: 1, closed: true });
    expect(await readPoolFacts(account)).toMatchObject({ closed: true, owed: 0 });
  });

  it("does not take a failed read of the logs for an empty pool", async () => {
    node({ count: 2, held: 2n * DENOM, deposits: 2, failLogs: true });
    await expect(readPoolFacts(account)).rejects.toThrow();
  });

  it("tells no pool from no answer", async () => {
    node({ count: 0, held: 0n, deposits: 0, revert: true });
    expect(await readPoolFacts(account)).toBeNull();
    node({ count: 0, held: 0n, deposits: 0, noCode: true });
    expect(await readPoolFacts(account)).toBeNull();
    setRpcFetch((async () => new Response("", { status: 502 })) as unknown as typeof fetch);
    await expect(readPoolFacts(account)).rejects.toBeInstanceOf(RpcError);
  });

  it("keeps a deposit's sender unknown when the chain does not say", async () => {
    node({ count: 1, held: DENOM, deposits: 1, from: null });
    const read = await readPoolFacts(account);
    expect(read!.depositors).toEqual([null]);
    expect(poolMeter(read!).state).toBe("unknown");
  });
});
