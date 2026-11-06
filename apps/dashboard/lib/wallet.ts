/** The daily key is whatever wallet the user already has. All it is ever asked for is one signature, as typed data it can show. */
import { type Address, type Hex, serializeTypedData } from "viem";
import { type FrameTx, dailyTypedData, takesTypedData, walletMessage, withTypedSignature, withWalletSignature } from "@vajra/core";

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

/**
 * Signs a daily transaction. A V2 account takes EIP-712 typed data, which the wallet can show as asset, recipient and amount. A V1
 * account still needs the blind personal_sign, because that is what it rebuilds.
 */
export async function signWithWallet(tx: FrameTx, address: Address): Promise<FrameTx> {
  const eth = provider()!;
  if (await takesTypedData(tx.sender)) {
    const signature = (await eth.request({ method: "eth_signTypedData_v4", params: [address, serializeTypedData(dailyTypedData(tx) as never)] })) as Hex;
    return withTypedSignature(tx, signature);
  }
  return withWalletSignature(tx, (await eth.request({ method: "personal_sign", params: [walletMessage(tx), address] })) as Hex);
}
