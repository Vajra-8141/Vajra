/** Deploys the implementations and factories. Safe to run again after a devnet reset: `pnpm vajra deploy`. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Address, type Hex, concat, encodeFunctionData, keccak256, numberToHex, parseAbi, parseEther, size } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, LEGACY_GAS_PRICE, genesisHash, isLocalStack, publicClient, useDeployments, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../core/src/artifacts/${name}.json`, import.meta.url), "utf8")) as { abi: never; bytecode: Hex };

// The mirror keeps its keys and addresses apart, so that nothing run against it can touch the public devnet's.
const stateDir = isLocalStack ? ".vajra-local" : ".vajra";
export const deploymentsPath = isLocalStack
  ? new URL("../../../.vajra-local/deployments.json", import.meta.url)
  : new URL("../../core/src/deployments/1337.json", import.meta.url);
// VAJRA_STATE_DIR gives a second account on one machine a folder of its own: a restore to prove, or a move into a new account.
export const keyPath = (name: string) => resolve(new URL("../../../", import.meta.url).pathname, process.env.VAJRA_STATE_DIR ?? stateDir, name);

if (isLocalStack && existsSync(deploymentsPath)) useDeployments(JSON.parse(readFileSync(deploymentsPath, "utf8")));

/** The most a proof transaction may cost an account, since nothing signs its fee, and what a note pays. About 3 gwei at these limits. */
const MAX_PROOF_TX_COST = parseEther("0.005");

/** The one size of note on the mirror. */
/** Mirror runs attacks by the dozen, so it asks for less. A real user grinds once, for a few seconds. */
const WORK_BITS = isLocalStack ? 10 : 18;
const DENOMINATION = parseEther(isLocalStack ? "0.1" : "0.01");

/** The paymasters' fee cap, and a price for the mirror's stand-in token. The price is a number we chose, and the contract says so. */
export const PAYMASTER_FEE_CAP = 3_000_000_000n;
const USDC_PER_ETH = 3_000_000_000n;
const PAYMASTER_STAKE = parseEther("0.012");
const PAYMASTER_FLOAT = parseEther("5");
const ONE_DAY = 86_400;

/** Stake is keyed on the caller, so the paymaster stakes for itself. Its gas float is a plain transfer. */
export async function stakePaymaster(key: Hex, address: Address) {
  const wallet = walletFor(key);
  const send = { gas: 1_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as const;
  await waitForSuccess(await wallet.sendTransaction({ to: address, value: PAYMASTER_FLOAT, ...send }), "funding the paymaster");
  const addStake = encodeFunctionData({ abi: parseAbi(["function addStake(uint32)"]), functionName: "addStake", args: [ONE_DAY] });
  const data = encodeFunctionData({ abi: parseAbi(["function callRegistry(bytes) payable"]), functionName: "callRegistry", args: [addStake] });
  await waitForSuccess(await wallet.sendTransaction({ to: address, data, value: PAYMASTER_STAKE, ...send }), "staking the paymaster");
}

/** Each implementation costs ~20M gas. `only` redeploys one part and keeps the addresses of the rest. */
export async function deploy(only?: string) {
  const key = loadOrCreateKey(keyPath("deployer.key"));
  const deployer = privateKeyToAccount(key).address;
  console.log("deployer", deployer, "balance", await publicClient.getBalance({ address: deployer }));
  const wallet = walletFor(key);

  async function create(name: string, args: unknown[], value = 0n): Promise<Address> {
    const { abi, bytecode } = load(name);
    const hash = await wallet.deployContract({ abi, bytecode, args: args as never, value, gas: name === "VajraAccountV2" ? 45_000_000n : 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
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
    out.paymaster = await create("SponsorPaymaster", [keccak256(cloneRuntime)], parseEther("0.015"));
    out.announcer ??= await createStock("ERC5564Announcer");
    out.registry ??= await createStock("ERC6538Registry");
  }
  if (want("v2")) {
    const recoveryVerifier = await create("RecoveryVerifier", []);
    const shieldVerifier = await create("ShieldVerifier", []);
    const poseidon = await create("PoseidonT3", []);
    const implementation = await create("VajraAccountV2", [4, 3, DEVNET.stakingRegistry, recoveryVerifier, shieldVerifier, poseidon, DENOMINATION, MAX_PROOF_TX_COST, WORK_BITS]);
    const factory = await create("VajraFactory", [implementation]);
    const exitImplementation = await create("VajraExit", [4, 3, DEVNET.stakingRegistry]);
    const exitFactory = await create("VajraExitFactory", [exitImplementation]);
    out.v2 = { implementation, factory, exitImplementation, exitFactory, recoveryVerifier, shieldVerifier, poseidon, denomination: DENOMINATION.toString(), noteFee: MAX_PROOF_TX_COST.toString(), workBits: WORK_BITS };
  }
  // The mirror only, with no switch to change that: the deployed sidecar's flat cap has no room for these.
  if (isLocalStack && want("paymasters")) {
    const quota = await create("QuotaPaymaster", [deployer, DEVNET.stakingRegistry, PAYMASTER_FEE_CAP, ONE_DAY]);
    const usdc = await create("UsdcPaymaster", [deployer, DEVNET.stakingRegistry, PAYMASTER_FEE_CAP, DEVNET.usdc, USDC_PER_ETH]);
    for (const address of [quota, usdc]) await stakePaymaster(key, address);
    out.paymasters = { quota, usdc, feeCap: PAYMASTER_FEE_CAP.toString(), usdcPerEth: USDC_PER_ETH.toString() };
  }
  writeFileSync(deploymentsPath, JSON.stringify(out, null, 1) + "\n");
  useDeployments(out as never);
  console.log("written", deploymentsPath.pathname);
  return out;
}
