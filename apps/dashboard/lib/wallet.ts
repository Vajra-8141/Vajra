/** The daily key is whatever wallet the user already has. All it is ever asked for is one personal_sign. */
import type { Address, Hex } from "viem";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const provider = () => (globalThis as { ethereum?: Eip1193 }).ethereum;

export const hasWallet = () => provider() !== undefined;

export async function connectWallet(): Promise<Address> {
  const eth = provider();
  if (!eth) throw new Error("no wallet found in this browser");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
  return address!;
}

export const personalSign = (message: Hex, address: Address) => provider()!.request({ method: "personal_sign", params: [message, address] }) as Promise<Hex>;
