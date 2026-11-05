/** Deploys the implementations and factories. Safe to run again after a devnet reset: `pnpm vajra deploy`. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Address, type Hex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, LEGACY_GAS_PRICE, ensureFunded, genesisHash, loadOrCreateKey, publicClient, waitForSuccess, walletFor } from "@vajra/core";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../core/src/artifacts/${name}.json`, import.meta.url), "utf8")) as { abi: never; bytecode: Hex };

export const deploymentsPath = new URL("../../core/src/deployments/1337.json", import.meta.url);
export const keyPath = (name: string) => new URL(`../../../.vajra/${name}`, import.meta.url).pathname;

/** Each implementation costs ~18M gas. `only` redeploys one of them and keeps the other's addresses. */
export async function deploy(only?: string) {
  const key = loadOrCreateKey(keyPath("deployer.key"));
  const deployer = privateKeyToAccount(key).address;
  console.log("deployer", deployer, "balance", await ensureFunded(deployer));
  const wallet = walletFor(key);

  async function create(name: string, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = load(name);
    const hash = await wallet.deployContract({ abi, bytecode, args: args as never, gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
    const receipt = await waitForSuccess(hash, `deploying ${name}`);
    console.log(`${name}(${args.join(", ")}) ${receipt.contractAddress}, ${receipt.gasUsed} gas`);
    return receipt.contractAddress!;
  }

  const genesis = await genesisHash();
  const previous = existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath, "utf8")) : {};
  const out: Record<string, unknown> = { ...previous, chainId: DEVNET.chainId, genesis };
  for (const [label, logW, len2] of [["w16", 4, 3], ["w256", 8, 3]] as const) {
    if (only && only !== label) continue;
    const implementation = await create("VajraAccount", [logW, len2]);
    const factory = await create("VajraFactory", [implementation]);
    out[label] = { implementation, factory, logW, len2 };
  }
  writeFileSync(deploymentsPath, JSON.stringify(out, null, 1) + "\n");
  console.log("written", deploymentsPath.pathname);
  return out;
}

export { zeroAddress, publicClient };
