/**
 * A user's wallet on this machine: the master signer, and what the account needs to remember.
 *
 * The master key here is a seed in a file. That is the software stand-in for the hardware signer, not a substitute for
 * it, and anything shown to a user should say so. Everything above this file only asks for operations; none of it sees
 * the seed, which is what lets a device take this file's place without the rest changing.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type Address, type Hex, bytesToHex, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ETH,
  MasterSigner,
  ROTATION_LEAF,
  WOTS_W16,
  accountState,
  assertRootMatches,
  createAccount,
  deployments,
  framesSucceeded,
  harborCommitment,
  ops,
  signMasterTx,
  submit,
  type Call,
} from "@vajra/core";
import { fileStore, loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";

/** Above this, the fitted cost would pass the VERIFY limit; the digest is redrawn before anything is revealed. */
const MAX_HASHES = 660;

export interface Wallet {
  account: Address;
  harbor: Address;
  harborSalt: Hex;
}

const walletPath = keyPath("wallet.json");
const signerPath = keyPath("signer.json");
const nextSignerPath = keyPath("signer.next.json");

export const loadWallet = (): Wallet | null => (existsSync(walletPath) ? (JSON.parse(readFileSync(walletPath, "utf8")) as Wallet) : null);

export function requireWallet(): Wallet {
  const wallet = loadWallet();
  if (!wallet) throw new Error("no account yet: run `vajra create`");
  return wallet;
}

const newSeed = () => new Uint8Array(randomBytes(32));

export const masterSigner = () => new MasterSigner(WOTS_W16, fileStore(signerPath), newSeed);

export interface CreateOptions {
  dailyKey: Address;
  harbor: Address;
  dailyLimit: string;
  coolingAllowance: string;
  queueDelay: number;
  coolingPeriod: number;
  fund: string;
}

export async function createWallet(o: CreateOptions): Promise<Wallet> {
  if (loadWallet()) throw new Error("an account already exists on this machine");
  const signer = masterSigner();
  const harborSalt = bytesToHex(randomBytes(32));
  const { w16, genesis } = deployments();
  const funder = loadOrCreateKey(keyPath("deployer.key"));
  const account = await createAccount(
    funder,
    w16.factory,
    {
      dailyKey: o.dailyKey,
      wotsRoot: signer.root,
      epochSalt: genesis,
      harborCommitment: harborCommitment(o.harbor, harborSalt),
      queueDelay: BigInt(o.queueDelay),
      coolingPeriod: BigInt(o.coolingPeriod),
      maxDailyTxCost: parseEther("0.01"),
      assets: [ETH],
      dailyLimits: [parseEther(o.dailyLimit)],
      coolingAllowances: [parseEther(o.coolingAllowance)],
    },
    parseEther(o.fund),
  );
  const wallet: Wallet = { account, harbor: o.harbor, harborSalt };
  writeFileSync(walletPath, JSON.stringify(wallet, null, 1), { mode: 0o600 });
  return wallet;
}

export type MasterOp =
  | { op: "veto"; id: string }
  | { op: "freeze" }
  | { op: "unfreeze" }
  | { op: "escape" }
  | { op: "setDailyKey"; key: Address }
  | { op: "setRule"; asset: Address; dailyLimit: string; coolingAllowance: string }
  | { op: "rotate" };

export interface MasterResult {
  hash: Hex;
  block: number;
  verifyGas: number;
  leaf: number;
  hashes: number;
  leavesLeft: number;
}

function callFor(request: MasterOp, wallet: Wallet): Call {
  switch (request.op) {
    case "veto":
      return ops.veto(BigInt(request.id));
    case "freeze":
      return ops.freeze();
    case "unfreeze":
      return ops.unfreeze();
    case "escape":
      return ops.escape(wallet.harbor, wallet.harborSalt);
    case "setDailyKey":
      return ops.setDailyKey(request.key);
    case "setRule":
      return ops.setRule(request.asset, parseEther(request.dailyLimit), parseEther(request.coolingAllowance));
    case "rotate":
      throw new Error("rotation is handled separately");
  }
}

/** Signs and lands one master operation. Refuses before signing if the chain's root is not this signer's. */
export async function runMasterOp(request: MasterOp, log: (line: string) => void = () => {}): Promise<MasterResult> {
  const wallet = requireWallet();
  const signer = masterSigner();
  const { epochSalt } = await assertRootMatches(signer, wallet.account);

  const rotating = request.op === "rotate";
  const next = rotating ? new MasterSigner(WOTS_W16, fileStore(nextSignerPath), newSeed) : null;
  const call = rotating ? ops.rotateRoot(next!.root) : callFor(request, wallet);
  // The reserved leaf is for when the ordinary ones are gone; a rotation before that uses an ordinary one.
  const signed = signMasterTx({ signer, account: wallet.account, epochSalt, calls: [call], rotation: rotating && signer.leavesLeft === 0, maxHashes: MAX_HASHES });
  const { hash, receipt } = await submit(signed.tx, { log });
  if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed`);
  if (rotating) {
    renameSync(signerPath, `${signerPath}.retired-${Date.now()}`);
    renameSync(nextSignerPath, signerPath);
  }
  return {
    hash,
    block: Number(receipt.blockNumber),
    verifyGas: Number(BigInt(receipt.frameReceipts[0]!.gasUsed)),
    leaf: signed.leaf,
    hashes: signed.hashes,
    leavesLeft: rotating ? ROTATION_LEAF : signer.leavesLeft,
  };
}

export async function walletStatus() {
  const wallet = loadWallet();
  const signer = masterSigner();
  const base = { signer: "software" as const, root: signer.root, leavesLeft: signer.leavesLeft, harbor: wallet?.harbor ?? null };
  if (!wallet) return { ...base, account: null, rootMatches: null };
  const state = await accountState(wallet.account);
  return { ...base, account: wallet.account, rootMatches: state.wotsRoot.toLowerCase() === signer.root.toLowerCase() };
}

export const dailyKeyPath = keyPath("daily.key");
export const localDailyKey = () => loadOrCreateKey(dailyKeyPath);
export const localDailyAddress = () => privateKeyToAccount(localDailyKey()).address;
