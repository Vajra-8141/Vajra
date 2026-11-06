/** What the two proof runs share: recording what was mined, and insisting that an attack dies with the right name. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, type Hex, parseEther } from "viem";
import {
  DEVNET,
  ETH,
  type FrameTx,
  LEGACY_GAS_PRICE,
  MasterSigner,
  RpcError,
  WOTS_W16,
  createAccount,
  deployments,
  framesSucceeded,
  harborCommitment,
  memoryStore,
  publicClient,
  accountV2Abi,
  refusalNameV2,
  rpc,
  sendAlt,
  signMasterTx,
  submit,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { V2_STAKE } from "./wallet.ts";

export const newSigner = () => new MasterSigner(WOTS_W16, memoryStore(), () => new Uint8Array(randomBytes(32)));

export const evidence: { step: string; hash: Hex; block: number; verifyGas: number; totalGas: number; attempts: number }[] = [];
export const refusals: { attack: string; refusal: string }[] = [];
export const tally = { failures: 0 };

export const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) tally.failures++;
};

export async function mined(step: string, tx: FrameTx) {
  const { hash, receipt, attempts } = await submit(tx, { log: (l) => console.log(`    ${l}`) });
  const verifyGas = Number(BigInt(receipt.frameReceipts[0]!.gasUsed));
  evidence.push({ step, hash, block: Number(receipt.blockNumber), verifyGas, totalGas: Number(BigInt(receipt.gasUsed)), attempts });
  check(framesSucceeded(receipt), `${step}: ${hash} block ${Number(receipt.blockNumber)}, VERIFY ${verifyGas} gas`);
  return { hash, receipt };
}

/** The attack has to die at admission, with this name. Anything else, including being admitted, is a failure. */
export async function refused(attack: string, tx: FrameTx, want: string) {
  try {
    const hash = await sendAlt(tx);
    check(false, `${attack}: ADMITTED ${hash}`);
    refusals.push({ attack, refusal: "ADMITTED" });
  } catch (error) {
    const message = error instanceof RpcError ? error.message : String(error);
    const name = refusalNameV2(message);
    check(name === want, `${attack}: ${name === want ? name : `${message.slice(0, 220)} (wanted ${want})`}`);
    refusals.push({ attack, refusal: name.slice(0, 200) });
  }
}

/** The revert a plain call gets, for the paths that are ordinary transactions. */
export async function reverts(attack: string, want: string, call: { account: Address; address: Address; functionName: string; args: unknown[]; value?: bigint }) {
  const outcome = await publicClient
    .simulateContract({ abi: accountV2Abi as never, ...call } as never)
    .then(() => "allowed", (error: Error) => error.message);
  check(outcome.includes(want), `${attack}: ${outcome.includes(want) ? want : outcome.slice(0, 200)}`);
  refusals.push({ attack, refusal: outcome.includes(want) ? want : outcome.slice(0, 200) });
}

export function newAccount(deployer: Hex, signer: MasterSigner, daily: Address, harbor: Address, salt: Hex, fund = parseEther("1"), factory = deployments().v2!.factory) {
  const { genesis } = deployments();
  return createAccount(
    deployer,
    factory,
    {
      dailyKey: daily,
      wotsRoot: signer.root,
      epochSalt: genesis,
      harborCommitment: harborCommitment(harbor, salt),
      queueDelay: 60n,
      coolingPeriod: 0n,
      maxDailyTxCost: parseEther("0.01"),
      assets: [ETH],
      dailyLimits: [parseEther("0.5")],
      coolingAllowances: [parseEther("0.5")],
      stake: V2_STAKE,
      unstakeDelay: 86_400,
    },
    fund,
  );
}

/** V2's VERIFY passes the 99,900 limit well under the 660 the CLI once allowed, sooner on the rotation leaf. A digest over this is redrawn, which costs a hash. */
const MAX_HASHES = 520;

export const master = (signer: MasterSigner, account: Address, epochSalt: Hex, calls: Parameters<typeof signMasterTx>[0]["calls"]) =>
  signMasterTx({ signer, account, epochSalt, calls, maxHashes: MAX_HASHES }).tx;

/** The bytes first deployed, put on the mirror, so that what they got wrong stays reproducible after the source is fixed. */
export async function preFixFactory(deployer: Hex): Promise<Address> {
  const load = (name: string) => JSON.parse(readFileSync(new URL(`../../core/src/artifacts/${name}.json`, import.meta.url), "utf8"));
  const wallet = walletFor(deployer);
  const place = async (artifact: { abi: never; bytecode: Hex }, args: unknown[]) => {
    const hash = await wallet.deployContract({ ...artifact, args: args as never, gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
    return (await waitForSuccess(hash, "placing the pre-fix contract")).contractAddress!;
  };
  return place(load("VajraFactory"), [await place(load("VajraAccount.pre-fix"), [4, 3, DEVNET.stakingRegistry])]);
}

/** V2 as it stood before `docs/FINDINGS.md` sections 13 and 14, with the mirror's own verifiers, for the same reason. */
export async function preFixV2Factory(deployer: Hex): Promise<Address> {
  const load = (name: string) => JSON.parse(readFileSync(new URL(`../../core/src/artifacts/${name}.json`, import.meta.url), "utf8"));
  const wallet = walletFor(deployer);
  const place = async (artifact: { abi: never; bytecode: Hex }, args: unknown[]) => {
    const hash = await wallet.deployContract({ ...artifact, args: args as never, gas: 45_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
    return (await waitForSuccess(hash, "placing the pre-fix contract")).contractAddress!;
  };
  const { v2 } = deployments();
  const implementation = await place(load("VajraAccountV2.pre-fix"), [4, 3, DEVNET.stakingRegistry, v2!.recoveryVerifier, v2!.shieldVerifier, v2!.poseidon, BigInt(v2!.denomination), BigInt(v2!.noteFee), v2!.workBits ?? 0]);
  return place(load("VajraFactory"), [implementation]);
}

export interface Reputation {
  address: Address;
  opsSeen: number;
  opsIncluded: number;
  status: string;
}

/** What this node's sidecar thinks of an address. Reputation is local to a node, and this is the mirror's only one. */
export async function reputationOf(address: Address): Promise<Reputation> {
  let cursor: string | undefined;
  for (;;) {
    const page = await rpc<{ items: Reputation[]; nextCursor?: string }>(DEVNET.mempool, "skandha_explorer_listReputation", [{ limit: 100, cursor }]);
    const found = page.items.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    if (found) return found;
    if (!page.nextCursor) return { address, opsSeen: 0, opsIncluded: 0, status: "ok" };
    cursor = page.nextCursor;
  }
}

/** A contract that burns all the gas it gets and refuses the money. Its one byte of code is INVALID. */
export async function deployRefuser(deployer: Hex): Promise<Address> {
  const hash = await walletFor(deployer).sendTransaction({ data: "0x60fe60005360016000f3", gas: 1_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  return (await waitForSuccess(hash, "placing the refuser")).contractAddress!;
}
