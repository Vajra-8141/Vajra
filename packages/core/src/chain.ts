/** Ordinary transactions: deployments, and anything that is not a frame transaction. */
import { type Address, type Chain, type Hex, createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, rpc, sleep } from "./devnet.ts";

export const chain: Chain = defineChain({
  id: DEVNET.chainId,
  name: "EIP-8141 devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEVNET.execution] } },
});

export const publicClient = createPublicClient({ chain, transport: http(DEVNET.execution) });

/** The base fee sits at 7 wei; this clears it by a wide margin without paying gwei for a multi-million-gas deploy. */
export const LEGACY_GAS_PRICE = 2_000_000n;

export const walletFor = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(DEVNET.execution) });

/** The faucet gives 1 ETH per address per hour. */
export async function ensureFunded(address: Address, minimum: bigint = parseEther("0.2")): Promise<bigint> {
  let balance = await publicClient.getBalance({ address });
  if (balance >= minimum) return balance;
  await rpc(DEVNET.gateway, "skandha_explorer_faucet", [address]);
  for (let i = 0; i < 40 && balance < minimum; i++) {
    await sleep(3000);
    balance = await publicClient.getBalance({ address });
  }
  if (balance < minimum) throw new Error(`faucet did not fund ${address}`);
  return balance;
}

export async function waitForSuccess(hash: Hex, what: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3000 });
  if (receipt.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  return receipt;
}
