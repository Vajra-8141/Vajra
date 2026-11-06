/** The provider and the key's sealing, with the browser taken out. test/e2e.mjs runs the same code in a real browser. */
import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { type Approval, type Deps, handle } from "../src/engine.ts";
import { open, seal } from "../src/vault.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const TO = "0x2222222222222222222222222222222222222222" as Address;
const SITE = "https://dapp.example";

function deps(over: Partial<Deps> = {}) {
  const connected = new Set<string>();
  const asked: Approval[] = [];
  const base: Deps = {
    chainId: 13370,
    account: async () => ACCOUNT,
    isConnected: async (origin) => connected.has(origin),
    setConnected: async (origin, on) => void (on ? connected.add(origin) : connected.delete(origin)),
    book: async () => ({}),
    approve: async (request) => (asked.push(request), true),
    forecast: async () => ({ outcome: "leaves", text: "", seenBefore: false, delay: 60 }),
    amountText: async () => "1 ETH",
    send: vi.fn(async () => "0xabc" as const),
    rpc: vi.fn(async () => "0x1"),
    emit: vi.fn(),
    ...over,
  };
  return { deps: base, connected, asked };
}

const failure = (work: Promise<unknown>) => work.then(() => null, (error: { code: number }) => error.code);

describe("connecting", () => {
  it("shows nothing to a site that has not been let in", async () => {
    expect(await handle(deps().deps, SITE, "eth_accounts")).toEqual([]);
  });

  it("asks once, then remembers, per origin", async () => {
    const { deps: d, asked } = deps();
    expect(await handle(d, SITE, "eth_requestAccounts")).toEqual([ACCOUNT]);
    expect(await handle(d, SITE, "eth_requestAccounts")).toEqual([ACCOUNT]);
    expect(asked.length).toBe(1);
    expect(await handle(d, "https://other.example", "eth_accounts")).toEqual([]);
    expect(d.emit).toHaveBeenCalledWith(SITE, "accountsChanged", [ACCOUNT]);
  });

  it("gives 4001 when the owner says no", async () => {
    expect(await failure(handle(deps({ approve: async () => false }).deps, SITE, "eth_requestAccounts"))).toBe(4001);
  });

  it("can be revoked", async () => {
    const { deps: d, connected } = deps();
    connected.add(SITE);
    await handle(d, SITE, "wallet_revokePermissions");
    expect(await handle(d, SITE, "eth_accounts")).toEqual([]);
  });
});

describe("paying", () => {
  const payment = [{ to: TO, value: "0x1" }];

  it("refuses a site that is not connected, before asking anyone", async () => {
    const { deps: d, asked } = deps();
    expect(await failure(handle(d, SITE, "eth_sendTransaction", payment))).toBe(4100);
    expect(asked.length).toBe(0);
  });

  it("shows the owner the warning and the forecast, then sends", async () => {
    const { deps: d, connected, asked } = deps();
    connected.add(SITE);
    expect(await handle(d, SITE, "eth_sendTransaction", payment)).toBe("0xabc");
    expect(asked[0]).toMatchObject({ kind: "payment", origin: SITE, recipient: TO, amountText: "1 ETH" });
    expect((asked[0] as Extract<Approval, { kind: "payment" }>).warnings.map((w) => w.code)).toEqual(["first-seen"]);
  });

  it("signs nothing when the owner says no", async () => {
    const { deps: d, connected } = deps({ approve: async () => false });
    connected.add(SITE);
    expect(await failure(handle(d, SITE, "eth_sendTransaction", payment))).toBe(4001);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("signs nothing the rulebook would refuse", async () => {
    const { deps: d, connected } = deps({ forecast: async () => ({ outcome: "refused", text: "frozen", seenBefore: true, delay: 60 }) });
    connected.add(SITE);
    expect(await failure(handle(d, SITE, "eth_sendTransaction", payment))).toBe(4200);
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe("everything else", () => {
  it("answers the chain", async () => {
    const { deps: d } = deps();
    expect(await handle(d, SITE, "eth_chainId")).toBe("0x343a");
    expect(await handle(d, SITE, "net_version")).toBe("13370");
    expect(await handle(d, SITE, "wallet_switchEthereumChain", [{ chainId: "0x343A" }])).toBeNull();
    expect(await failure(handle(d, SITE, "wallet_switchEthereumChain", [{ chainId: "0x1" }]))).toBe(4902);
  });

  it("passes reads to the node", async () => {
    const { deps: d } = deps();
    await handle(d, SITE, "eth_getBalance", [ACCOUNT, "latest"]);
    expect(d.rpc).toHaveBeenCalledWith("eth_getBalance", [ACCOUNT, "latest"]);
  });

  it.each(["personal_sign", "eth_sign", "eth_signTypedData_v4", "eth_sendRawTransaction", "eth_sendFrameTransaction", "debug_traceTransaction"])("refuses %s, and never reaches the node", async (method) => {
    const { deps: d } = deps();
    expect(await failure(handle(d, SITE, method, []))).toBe(4200);
    expect(d.rpc).not.toHaveBeenCalled();
  });
});

describe("the vault", () => {
  it("opens with the password only", async () => {
    const vault = await seal("0xsecret", "long enough", 1000);
    expect(JSON.stringify(vault)).not.toContain("secret");
    expect(await open(vault, "long enough")).toBe("0xsecret");
    await expect(open(vault, "wrong password")).rejects.toThrow("wrong password");
  });

  it("refuses a short password", async () => {
    await expect(seal("0xsecret", "short", 1000)).rejects.toThrow("at least 8");
  });
});
