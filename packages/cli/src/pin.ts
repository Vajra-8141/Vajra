/**
 * Can a thief holding the daily key keep the master key out of the mempool?
 *
 * The canonical mempool will not hold a keyed transaction next to a pending linear one from the same sender. The thief
 * has the daily key, so the thief can always keep a linear transaction pending. This tests whether that really stops
 * the escape on the canonical path, and whether the alt mempool, which keeps the two nonce domains independent, admits
 * the same escape at the same moment.
 */
import { keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ETH,
  MasterSigner,
  RpcError,
  WOTS_W16,
  accountState,
  createAccount,
  dailyTx,
  deployments,
  framesSucceeded,
  harborCommitment,

  memoryStore,
  ops,
  publicClient,
  sendCanonical,
  signDailyTx,
  signMasterTx,
  submit,
  txHash,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";

const key = loadOrCreateKey(keyPath("deployer.key"));
const { w16, genesis } = deployments();
const dailyPrivate = generatePrivateKey();
const daily = privateKeyToAccount(dailyPrivate).address;
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const thief = privateKeyToAccount(generatePrivateKey()).address;
const salt = keccak256(toHex(`pin ${Date.now()}`));
const signer = new MasterSigner(WOTS_W16, memoryStore(), () => crypto.getRandomValues(new Uint8Array(32)));

const account = await createAccount(
  key,
  w16.factory,
  {
    dailyKey: daily,
    wotsRoot: signer.root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(harbor, salt),
    queueDelay: 86_400n,
    coolingPeriod: 86_400n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("0.001")],
    coolingAllowances: [parseEther("0.0001")],
  },
  parseEther("0.02"),
);
console.log("account", account);

const verdict = async (label: string, send: () => Promise<unknown>) => {
  try {
    const result = await send();
    console.log(`${label}: ACCEPTED ${result}`);
    return true;
  } catch (error) {
    console.log(`${label}: REFUSED ${error instanceof RpcError ? error.message : error}`);
    return false;
  }
};

const escape = signMasterTx({ signer, account, epochSalt: genesis, calls: [ops.escape(harbor, salt)], maxHashes: 660 }).tx;
const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
console.log("base fee", base, "account nonce", nonce);

// A real, valid transaction from the thief. On an idle devnet it mines within a slot, so the escape has to be offered
// inside that same slot; on a busy chain a transaction priced at the base fee can sit for far longer.
const pin = await signDailyTx(
  dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, thief, 1n)], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }),
  dailyPrivate,
);

// Start just after a block lands, for the longest window before the next one.
const start = await publicClient.getBlockNumber();
while ((await publicClient.getBlockNumber()) === start) await new Promise((r) => setTimeout(r, 200));

const pinned = await verdict("thief's transaction, canonical mempool", () => sendCanonical(pin));
if (!pinned) {
  console.log("\nINCONCLUSIVE: the thief's transaction was not admitted, so nothing held the slot and this tests nothing");
  process.exit(2);
}
const receipt = await publicClient.request({ method: "eth_getTransactionReceipt" as never, params: [txHash(pin)] as never });
console.log("thief's transaction still pending:", receipt === null);

console.log("\nthe same signed escape, offered to both mempools while the thief's transaction is pending:");
const canonical = await verdict("escape, canonical mempool", () => sendCanonical(escape));
if (canonical) {
  console.log("\nRESULT: the canonical mempool admitted the escape despite a pending thief transaction");
  process.exit(0);
}
const { hash, receipt: mined, attempts } = await submit(escape, { log: (l) => console.log(`  ${l}`) });
console.log(`escape, alt mempool: mined ${hash} block ${Number(mined.blockNumber)} after ${attempts} attempt(s), all frames ok: ${framesSucceeded(mined)}`);
console.log("harbor balance", await publicClient.getBalance({ address: harbor }), "frozen", (await accountState(account)).frozen);
console.log("\nRESULT: the canonical mempool refused the escape while the thief held the slot; the alt mempool carried it");
