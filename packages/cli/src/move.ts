/**
 * `vajra move`: a new VAJRA account, and an EOA's ETH and listed tokens in it, in one transaction. See packages/shared/src/move.ts.
 *
 * The master key is made here and stays here. The EOA only signs the one transaction, and its key is read from a file, not from the
 * command line. A local mirror only, for now: this has not been tried on the public devnet.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Address, type Hex, bytesToHex, formatEther, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, type FrameReceipt, accountState, deployments, framesSucceeded, harborCommitment, isLocalStack, predictAccount, publicClient, receiptOf, signDailyTx, simulate, submit } from "@vajra/core";
import { type MoveOptions, moveConfig, planMove, readHoldings } from "@vajra/shared/move";
import { keyPath } from "./deploy.ts";
import { V2_STAKE, type Wallet, loadWallet, masterSigner } from "./wallet.ts";

export interface MoveRequest {
  eoa: Address;
  harbor: Address;
  tokens: Address[];
  dailyLimit: string;
  coolingAllowance: string;
  queueDelay: number;
  coolingPeriod: number;
}

export interface PreparedMove {
  factory: Address;
  account: Address;
  options: MoveOptions;
}

const pendingPath = () => keyPath("wallet.pending.json");

function refuseUnlessReady() {
  if (!isLocalStack) throw new Error("the move runs on the mirror only, with VAJRA_STACK=local");
  if (process.env.VAJRA_SIGNER === "device") throw new Error("the move makes a software master key");
  if (loadWallet()) throw new Error("an account already exists here. Use another VAJRA_STATE_DIR");
}

function checkAddress(what: string, value: string | undefined): Address {
  if (!value || !isAddress(value, { strict: false })) throw new Error(`${what} is not an address`);
  return getAddress(value);
}

/**
 * Makes the master key and works out the new address. The wallet is written down before anything is sent, so a crash between
 * the transaction and the next line cannot leave money in an account whose harbor salt is lost.
 */
export async function prepareMove(r: MoveRequest): Promise<PreparedMove> {
  refuseUnlessReady();
  const eoa = checkAddress("the EOA", r.eoa);
  const harbor = checkAddress("the harbor", r.harbor);
  const tokens = r.tokens.map((token) => checkAddress("a token", token));
  if (harbor === eoa) throw new Error("the harbor cannot be the EOA: a stolen wallet key would then hold the way out");

  mkdirSync(dirname(pendingPath()), { recursive: true });
  const { v2, w16, genesis } = deployments();
  const factory = v2?.factory ?? w16.factory;
  const harborSalt = bytesToHex(randomBytes(32));
  const options: MoveOptions = {
    eoa,
    wotsRoot: masterSigner().root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(harbor, harborSalt),
    dailyLimit: r.dailyLimit,
    coolingAllowance: r.coolingAllowance,
    queueDelay: r.queueDelay,
    coolingPeriod: r.coolingPeriod,
    tokens,
    stake: v2 ? V2_STAKE : 0n,
    unstakeDelay: v2 ? 86_400 : 0,
  };
  const account = await predictAccount(factory, moveConfig(options));
  const wallet: Wallet = { account, harbor, harborSalt };
  writeFileSync(pendingPath(), JSON.stringify(wallet, null, 1), { mode: 0o600 });
  return { factory, account, options };
}

/** Believes the chain, not the caller: the account has to exist, under this signer's root, before the wallet is kept. */
export async function finishMove(hash: Hex): Promise<Wallet> {
  if (!existsSync(pendingPath())) throw new Error("no move is in progress here");
  const wallet = JSON.parse(readFileSync(pendingPath(), "utf8")) as Wallet;
  const receipt = (await receiptOf(hash)) as FrameReceipt | null;
  if (!receipt) throw new Error(`${hash} is not mined`);
  if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed, so nothing moved`);
  const { wotsRoot } = await accountState(wallet.account);
  if (wotsRoot.toLowerCase() !== masterSigner().root.toLowerCase()) throw new Error("the new account does not hold this signer's root");
  renameSync(pendingPath(), keyPath("wallet.json"));
  return wallet;
}

function readKey(path: string | undefined): Hex {
  if (!path) throw new Error("--key-file <file> is required: the EOA's private key, in a file, so that it stays out of your shell history");
  const key = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} does not hold a private key`);
  return key as Hex;
}

export async function moveCommand(flags: Record<string, string>) {
  const key = readKey(flags["key-file"]);
  const eoa = privateKeyToAccount(key).address;
  const request: MoveRequest = {
    eoa,
    harbor: flags.harbor as Address,
    tokens: (flags.tokens ?? "").split(",").filter(Boolean) as Address[],
    dailyLimit: flags.limit ?? "0.01",
    coolingAllowance: flags.allowance ?? "0.001",
    queueDelay: Number(flags.delay ?? 86_400),
    coolingPeriod: Number(flags.cooling ?? 86_400),
  };
  const { factory, account, options } = await prepareMove(request);
  const holdings = await readHoldings(eoa, options.tokens);
  const plan = planMove({ factory, account, config: moveConfig(options), eoa, holdings });

  console.log(`from ${eoa}, which stays on as the daily key\nto   ${account}, a new account on chain ${DEVNET.chainId}`);
  console.log(`ETH  ${formatEther(plan.ether)}${options.stake ? `, of which ${formatEther(options.stake)} is staked by the account` : ""}`);
  for (const token of holdings.tokens) console.log(`token ${token.address}: ${token.balance}${token.balance === 0n ? ", nothing to move, a rule only" : ""}`);

  const signed = await signDailyTx(plan.tx, key);
  // Safe to try first: an EOA signature can be repeated, unlike a one-time key's.
  const trial = await simulate(signed);
  if (trial.executionStatus !== "success" || trial.frames?.some((frame) => !frame.succeeded)) throw new Error(`the move would fail, so it was not sent: ${trial.executionError ?? JSON.stringify(trial.frames)}`);

  const { hash, receipt } = await submit(signed, { log: console.log });
  const wallet = await finishMove(hash);
  const left = await publicClient.getBalance({ address: eoa });
  console.log(`mined ${hash}, block ${Number(BigInt(receipt.blockNumber))}, ${receipt.frameReceipts.length} frames, one transaction`);
  console.log(`account ${wallet.account} holds ${formatEther(await publicClient.getBalance({ address: wallet.account }))} ETH`);
  console.log(`left at ${eoa}: ${formatEther(left)} ETH, the refund of unused gas, which arrives after the last frame`);
  console.log(`written to ${dirname(keyPath("wallet.json"))}`);
}
