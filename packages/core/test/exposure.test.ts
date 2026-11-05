import { describe, expect, it } from "vitest";
import { classifyExposure, scanAddress } from "../src/exposure.ts";
import { setRpcFetch } from "../src/devnet.ts";

const address = "0x000000000000000000000000000000000000dEaD";

describe("classifyExposure", () => {
  it("an EOA that has sent a transaction is exposed", () => {
    expect(classifyExposure({ address, nonce: 1n, code: "0x", balance: 0n }).verdict).toBe("exposed");
  });

  it("an EOA that never sent one shows no key", () => {
    expect(classifyExposure({ address, nonce: 0n, code: "0x", balance: 5n }).verdict).toBe("no-key-on-chain");
  });

  it("a contract is neither", () => {
    expect(classifyExposure({ address, nonce: 1n, code: "0x6000", balance: 0n }).verdict).toBe("contract");
  });

  it("an EIP-7702 account is exposed, even with a nonce of zero and code present", () => {
    expect(classifyExposure({ address, nonce: 0n, code: `0xef0100${"11".repeat(20)}`, balance: 0n }).verdict).toBe("delegated");
  });
});

describe("scanAddress", () => {
  it("a failed read is unknown, never a clean bill of health", async () => {
    setRpcFetch(() => Promise.reject(new Error("network down")));
    const report = await scanAddress("https://example.invalid", address);
    setRpcFetch((...args) => fetch(...args));
    expect(report.verdict).toBe("unknown");
    expect(report.nonce).toBeNull();
  });
});
