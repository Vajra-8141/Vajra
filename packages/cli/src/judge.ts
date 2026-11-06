/**
 * Everything after the containers are up: the whole suite deployed, one funded demo account, and the checklist. Run through
 * `make judge`, which boots the mirror first.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Address, formatEther, parseEther } from "viem";
import { DEVNET, LEGACY_GAS_PRICE, deployments, isLocalStack, publicClient, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { deploy, keyPath } from "./deploy.ts";
import { createWallet, localDailyAddress, runMasterOp } from "./wallet.ts";

if (!isLocalStack) throw new Error("judge mode is the local mirror: run `make judge`");

const started = Date.now();
await deploy();

// `vajra budget` wants a staked sender of its own. This is what shows a staked limit over 100,000 being admitted.
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const probe = loadOrCreateKey(keyPath("probe.key"));
const probeAddress = privateKeyToAccount(probe).address;
const funded = await walletFor(deployer).sendTransaction({ to: probeAddress, value: parseEther("1"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
await waitForSuccess(funded, "funding the probe");
const stakeAbi = [{ type: "function", name: "addStake", stateMutability: "payable", inputs: [{ type: "uint32" }], outputs: [] }] as const;
await waitForSuccess(
  await walletFor(probe).writeContract({ address: DEVNET.stakingRegistry, abi: stakeAbi, functionName: "addStake", args: [86_400], value: parseEther("0.012"), gas: 1_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined }),
  "staking the probe",
);

const harbor: Address = privateKeyToAccount(generatePrivateKey()).address;
const wallet = await createWallet({ dailyKey: localDailyAddress(), harbor, dailyLimit: "0.1", coolingAllowance: "0.01", queueDelay: 60, coolingPeriod: 30, fund: "2" });
const first = await runMasterOp({ op: "freeze" });
await runMasterOp({ op: "unfreeze" });

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`
GREEN. Chain ${DEVNET.chainId}, genesis ${deployments().genesis}
Suite deployed and a master transaction mined (VERIFY ${first.verifyGas} gas), in ${seconds}s.
Demo account ${wallet.account}, ${formatEther(await publicClient.getBalance({ address: wallet.account }))} ETH, harbor ${harbor}
Explorer http://127.0.0.1:18080

This is the local mirror, not the public devnet. It has its own chain id, and nothing here is public-devnet evidence.

    alias vajra='VAJRA_STACK=local node packages/cli/src/main.ts'

    vajra recover                  recovery by proof, every attack              about 70s
    vajra shielded                 the shielded pool, every attack              about 80s
    vajra shield                   one note in, on the demo account
    vajra unshield 0xSomeAddress   one note out, with no key
    vajra e2e                      the rulebook and every attack                about 2.5 min
    vajra pin                      the blocked escape, both mempools            about 15s
    vajra stealth                  stealth payment and paymaster                about 20s
    vajra measure                  the gas table                                about 2 min
    vajra budget                   a staked limit over 100,000, admitted
    vajra nonce-burn               the flaw as first deployed. Then: nonce-burn fixed

JUDGES.md maps every capability to its command.
`);
