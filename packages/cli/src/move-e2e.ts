/**
 * The move on the mirror: a new account and an EOA's money in it, in one real frame transaction, and what happens when part of it fails.
 * The EOA is funded here by the mirror's throwaway deployer. Everything after that is the real command on the real chain.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, formatEther, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, ETH, LEGACY_GAS_PRICE, MasterSigner, WOTS_W16, accountAbi, accountState, deployments, harborCommitment, isLocalStack, memoryStore, ops, publicClient, receiptOf, sendAlt, signDaily, signDailyTx, sleep, submit, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { moveConfig, planMove, readHoldings } from "@vajra/shared/move";
import { keyPath } from "./deploy.ts";
import { check, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("run this on the mirror, with VAJRA_STACK=local");

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const usdc = DEVNET.usdc;
const USDC = 7_500_000n;
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const tokenBalance = (who: Address) => publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [who] });

async function fundedEoa(ether: string, token: bigint) {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const wallet = walletFor(deployer);
  await waitForSuccess(await wallet.sendTransaction({ to: address, value: parseEther(ether), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "funding the EOA");
  if (token) await waitForSuccess(await wallet.writeContract({ address: usdc, abi: erc20, functionName: "transfer", args: [address, token], gas: 400_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined }), "funding the EOA with tokens");
  return { key, address };
}

const dir = mkdtempSync(join(tmpdir(), "vajra-move-"));
const vajra = (stateDir: string, args: string[]) =>
  spawnSync(process.execPath, [new URL("./main.ts", import.meta.url).pathname, ...args], { env: { ...process.env, VAJRA_STATE_DIR: stateDir }, encoding: "utf8" });

console.log("\n1. One command: the account is made and the money is in it");
const eoa = await fundedEoa("1", USDC);
const keyFile = join(dir, "eoa.txt");
writeFileSync(keyFile, eoa.key, { mode: 0o600 });
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const state = join(dir, "state");
mkdirSync(state);
const moved = vajra(state, ["move", "--key-file", keyFile, "--harbor", harbor, "--tokens", usdc, "--limit", "0.1", "--allowance", "0.01", "--delay", "60", "--cooling", "30"]);
console.log(moved.stdout.trim().split("\n").map((line) => `  ${line}`).join("\n"));
if (moved.status !== 0) console.log(moved.stderr);
check(moved.status === 0, "vajra move finished");

const account = /to\s+(0x[0-9a-fA-F]{40})/.exec(moved.stdout)?.[1] as Address;
const hash = /mined (0x[0-9a-f]{64})/.exec(moved.stdout)?.[1] as Hex;
const receipt = await receiptOf(hash);
check(receipt?.frameReceipts.length === 3, `one transaction, three frames: ${receipt?.frameReceipts.length}`);
check(receipt?.frameReceipts.every((frame) => frame.status === "0x1") === true, "every frame succeeded");
check(((await publicClient.getCode({ address: account })) ?? "0x") !== "0x", "the account exists");
check((await tokenBalance(account)) === USDC, `the account holds the tokens: ${await tokenBalance(account)}`);
check((await tokenBalance(eoa.address)) === 0n, "the EOA holds no tokens");
const left = await publicClient.getBalance({ address: eoa.address });
check(left < parseEther("0.01"), `the EOA keeps only the gas refund: ${formatEther(left)} ETH`);
const held = await publicClient.getBalance({ address: account });
const stake = deployments().v2 ? parseEther("0.012") : 0n;
check(held + stake + left > parseEther("0.99"), `the account holds the rest, less its stake: ${formatEther(held)} ETH`);
const chain = await accountState(account);
check(chain.dailyKey === eoa.address, "the old EOA is the daily key: you keep your wallet");

console.log("\n2. The new account works: the old key has a limit, and the new master key outranks it");
const dailySpend = await signDaily({ key: eoa.key, dailyKey: eoa.address, account, calls: [ops.spend(ETH, harbor, parseEther("0.005"))] });
await submit(dailySpend);
check((await publicClient.getBalance({ address: harbor })) === parseEther("0.005"), "the old key spent a small amount");
const next = (await publicClient.readContract({ address: account, abi: accountAbi, functionName: "nextItem" })) as bigint;
await submit(await signDaily({ key: eoa.key, dailyKey: eoa.address, account, calls: [ops.spend(ETH, harbor, parseEther("0.5"))] }));
check(((await publicClient.readContract({ address: account, abi: accountAbi, functionName: "nextItem" })) as bigint) === next + 1n, "a big spend queued instead");
const veto = vajra(state, ["veto", next.toString()]);
if (veto.status !== 0) console.log(veto.stderr);
check(veto.status === 0, "the master key from the move vetoed it");

console.log("\n3. A move that cannot finish moves nothing");
const failing = await fundedEoa("1", USDC);
const signer = new MasterSigner(WOTS_W16, memoryStore(), () => new Uint8Array(randomBytes(32)));
const { v2, w16, genesis } = deployments();
const factory = v2?.factory ?? w16.factory;
const options = {
  eoa: failing.address,
  wotsRoot: signer.root,
  epochSalt: genesis,
  harborCommitment: harborCommitment(harbor, `0x${"11".repeat(32)}`),
  dailyLimit: "0.1",
  coolingAllowance: "0.01",
  queueDelay: 60,
  coolingPeriod: 30,
  tokens: [usdc],
  stake: v2 ? parseEther("0.012") : 0n,
  unstakeDelay: v2 ? 86_400 : 0,
};
const { predictAccount } = await import("@vajra/core");
const config = moveConfig(options);
const target = await predictAccount(factory, config);
const holdings = await readHoldings(failing.address, [usdc]);
// A token transfer of more than the EOA holds: the last frame has to fail, and the batch has to take the first frame down with it.
const plan = planMove({ factory, account: target, config, eoa: failing.address, holdings: { ...holdings, tokens: [{ address: usdc, balance: USDC * 2n }] } });
const before = await publicClient.getBalance({ address: failing.address });
const signed = await signDailyTx(plan.tx, failing.key);
const outcome = await sendAlt(signed).then(
  async (sent) => {
    for (let i = 0; i < 20; i++) {
      const mined = await receiptOf(sent);
      if (mined) return `mined, frames ${mined.frameReceipts.map((frame) => frame.status).join(" ")}`;
      await sleep(1000);
    }
    return "never mined";
  },
  (error: Error) => `refused by the mempool: ${error.message.slice(0, 120)}`,
);
console.log(`  ${outcome}`);
check(((await publicClient.getCode({ address: target })) ?? "0x") === "0x", "no account was created");
const after = await publicClient.getBalance({ address: failing.address });
check(after > before - parseEther("0.01"), `the ETH stayed with the EOA, less any gas: ${formatEther(after)}`);
check((await tokenBalance(failing.address)) === USDC, "the tokens stayed with the EOA");

console.log("\n4. The commands around it");
const twice = vajra(state, ["move", "--key-file", keyFile, "--harbor", harbor]);
check(twice.status !== 0 && twice.stderr.includes("already exists"), "a second move into the same folder is refused");
check(!moved.stdout.includes(eoa.key.slice(2)), "the key was not printed");

console.log(`\n${tally.failures} failures`);
process.exit(tally.failures ? 1 : 0);
