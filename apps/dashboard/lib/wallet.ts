/** The daily key is whatever wallet the user already has. All it is ever asked for is one personal_sign. */
import type { Address, Hex } from "viem";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

// With several wallets installed, or in Brave, `window.ethereum` can belong to any of them, and a click then opens nothing.
// EIP-6963 has each wallet announce itself, so MetaMask can be asked for by name.
const METAMASK = "io.metamask";
const announced = new Map<string, Eip1193>();
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = (event as CustomEvent<{ info: { rdns: string }; provider: Eip1193 }>).detail;
    announced.set(info.rdns, provider);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

const provider = () => announced.get(METAMASK) ?? (globalThis as { ethereum?: Eip1193 }).ethereum;

export const hasWallet = () => provider() !== undefined;

export async function connectWallet(): Promise<Address> {
  const eth = provider();
  if (!eth) throw new Error("no wallet found in this browser");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
  return address!;
}

export const personalSign = (message: Hex, address: Address) => provider()!.request({ method: "personal_sign", params: [message, address] }) as Promise<Hex>;
