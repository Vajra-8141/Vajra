/** Deploys the implementations and factories. Safe to run again after a devnet reset: `pnpm vajra deploy`. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Address, type Hex, concat, keccak256, numberToHex, parseEther, size } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, LEGACY_GAS_PRICE, genesisHash, publicClient, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../core/src/artifacts/${name}.json`, import.meta.url), "utf8")) as { abi: never; bytecode: Hex };

export const deploymentsPath = new URL("../../core/src/deployments/1337.json", import.meta.url);
export const keyPath = (name: string) => new URL(`../../../.vajra/${name}`, import.meta.url).pathname;

/** Each implementation costs ~20M gas. `only` redeploys one part and keeps the addresses of the rest. */
export async function deploy(only?: string) {
  const key = loadOrCreateKey(keyPath("deployer.key"));
  const deployer = privateKeyToAccount(key).address;
  console.log("deployer", deployer, "balance", await publicClient.getBalance({ address: deployer }));
  const wallet = walletFor(key);

  async function create(name: string, args: unknown[], value = 0n): Promise<Address> {
    const { abi, bytecode } = load(name);
    const hash = await wallet.deployContract({ abi, bytecode, args: args as never, value, gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
    const receipt = await waitForSuccess(hash, `deploying ${name}`);
    console.log(`${name} ${receipt.contractAddress}, ${receipt.gasUsed} gas`);
    return receipt.contractAddress!;
  }

  /** The stock contracts, with the runtime bytes mainnet runs. Only the address differs. */
  async function createStock(name: string): Promise<Address> {
    const { runtime } = JSON.parse(readFileSync(new URL(`../../core/src/artifacts/stock/${name}.json`, import.meta.url), "utf8")) as { runtime: Hex };
    const length = size(runtime);
    const initCode = concat(["0x61", numberToHex(length, { size: 2 }), "0x80600a5f395ff3", runtime]);
    const hash = await wallet.sendTransaction({ data: initCode, gas: 12_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
    const receipt = await waitForSuccess(hash, `deploying ${name}`);
    const code = await publicClient.getCode({ address: receipt.contractAddress! });
    if (code !== runtime) throw new Error(`${name} does not match the mainnet runtime`);
    console.log(`${name} ${receipt.contractAddress}, identical to mainnet, ${receipt.gasUsed} gas`);
    return receipt.contractAddress!;
  }

  const genesis = await genesisHash();
  const previous = existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath, "utf8")) : {};
  const out: Record<string, any> = { ...previous, chainId: DEVNET.chainId, genesis };
  const want = (part: string) => !only || only === part;

  for (const [label, logW, len2] of [["w16", 4, 3], ["w256", 8, 3]] as const) {
    if (!want(label)) continue;
    const implementation = await create("VajraAccount", [logW, len2, DEVNET.stakingRegistry]);
    const factory = await create("VajraFactory", [implementation]);
    out[label] = { implementation, factory, logW, len2 };
  }
  if (want("stealth")) {
    const cloneRuntime = concat(["0x363d3d373d3d3d363d73", out.w16.implementation, "0x5af43d82803e903d91602b57fd5bf3"]);
    out.paymaster = await create("SponsorPaymaster", [keccak256(cloneRuntime)], parseEther("0.05"));
    out.announcer ??= await createStock("ERC5564Announcer");
    out.registry ??= await createStock("ERC6538Registry");
  }
  writeFileSync(deploymentsPath, JSON.stringify(out, null, 1) + "\n");
  console.log("written", deploymentsPath.pathname);
  return out;
}
