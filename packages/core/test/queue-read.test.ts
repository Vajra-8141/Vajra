import { type Hex, decodeFunctionData, encodeFunctionResult, zeroAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { accountAbi, readAccount, setRpcFetch } from "../src/index.ts";

const WAITING = 1;
const EXECUTED = 2;
const VETOED = 3;

/** A node answering for one account, whose queue holds these states. Records which items it was asked for. */
function nodeWith(states: number[]) {
  const asked: bigint[] = [];
  const answer = (call: { method: string; params: { data: Hex }[] }) => {
    if (call.method === "eth_getBalance") return "0x1";
    const { functionName, args } = decodeFunctionData({ abi: accountAbi, data: call.params[0]!.data }) as { functionName: string; args?: readonly unknown[] };
    const encode = (result: unknown) => encodeFunctionResult({ abi: accountAbi, functionName, result } as never);
    switch (functionName) {
      case "dailyKey":
        return encode(zeroAddress);
      case "frozen":
        return encode(false);
      case "nextItem":
        return encode(BigInt(states.length));
      case "rule":
        return encode([true, 1n, 1n, 0n]);
      case "queuedItem": {
        const id = args![0] as bigint;
        asked.push(id);
        return encode({ recipient: zeroAddress, asset: zeroAddress, amount: 1n, executeAfter: 1n, state: states[Number(id)] });
      }
      default:
        throw new Error(`unexpected ${functionName}`);
    }
  };
  setRpcFetch((async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { id: number; method: string; params: { data: Hex }[] } | { id: number; method: string; params: { data: Hex }[] }[];
    const reply = Array.isArray(body) ? body.map((call) => ({ jsonrpc: "2.0", id: call.id, result: answer(call) })) : { jsonrpc: "2.0", id: body.id, result: answer(body) };
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  return asked;
}

let nextAccount = 1;
const anAccount = () => `0x${(nextAccount++).toString(16).padStart(40, "0")}` as const;

describe("readAccount", () => {
  afterEach(() => setRpcFetch((...args) => fetch(...args)));

  it("shows a waiting item with a dozen newer ones queued behind it", async () => {
    nodeWith(Array(13).fill(WAITING));
    const { items } = await readAccount(anAccount());
    expect(items.map((item) => item.id)).toContain(0n);
    expect(items).toHaveLength(13);
  });

  it("finds one waiting item far back, past the items already settled", async () => {
    nodeWith([...Array(500).fill(EXECUTED).map((_, i) => (i === 3 ? WAITING : EXECUTED)), ...Array(20).fill(VETOED)]);
    const { items } = await readAccount(anAccount());
    expect(items.filter((item) => item.state === WAITING).map((item) => item.id)).toEqual([3n]);
    expect(items).toHaveLength(13);
  });

  it("does not show settled items older than the newest twelve", async () => {
    nodeWith(Array(30).fill(VETOED));
    const { items } = await readAccount(anAccount());
    expect(items.map((item) => item.id)).toEqual(Array.from({ length: 12 }, (_, i) => BigInt(18 + i)));
  });

  it("does not read settled items again on the next poll, and does not skip a waiting one", async () => {
    const account = anAccount();
    const asked = nodeWith([...Array(40).fill(EXECUTED), WAITING, ...Array(20).fill(EXECUTED)]);
    await readAccount(account);
    asked.length = 0;
    const { items } = await readAccount(account);
    expect(asked[0]).toBe(40n);
    expect(items.some((item) => item.id === 40n)).toBe(true);
  });

  it("does not move its mark into the newest twelve, which are read every time anyway", async () => {
    const account = anAccount();
    const asked = nodeWith(Array(20).fill(EXECUTED));
    await readAccount(account);
    asked.length = 0;
    await readAccount(account);
    expect(asked[0]).toBe(8n);
  });

  it("reads a queue of two pages, and throws rather than call a failed read an empty queue", async () => {
    nodeWith(Array(250).fill(WAITING));
    expect((await readAccount(anAccount())).items).toHaveLength(250);
    setRpcFetch((async () => new Response("no", { status: 502 })) as typeof fetch);
    await expect(readAccount(anAccount())).rejects.toThrow();
  });
});
