/**
 * A user's wallet on this machine: the master signer, and what the account needs to remember.
 *
 * `VAJRA_SIGNER=device` keeps the master key on the hardware signer. Otherwise it is a seed in a file on this machine, on
 * the same computer as the wallet, and anything shown to a user has to say so. Everything above this file only asks for
 * operations, and none of it sees the seed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type Address, type Hex, bytesToHex, hexToBytes, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ChainStateUnknown,
  DEVNET,
  ETH,
  MasterSigner,
  ROTATION_LEAF,
  WOTS_W16,
  accountState,
  assertRootMatches,
  createAccount,
  deployments,
  encodeTx,
  framesSucceeded,
  harborCommitment,
  ops,
  predictAccount,
  prepareMasterTx,
  signMasterTx,
  submit,
  verifyMasterSignature,
  withMasterSignature,
  type Call,
} from "@vajra/core";
import { fileStore, loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { Device } from "./device.ts";
import { claimLeaf, publishUse, theRegistry } from "./registry.ts";

/** Above this, the fitted cost would pass the VERIFY limit; the digest is redrawn before anything is revealed. */
const MAX_HASHES = 660;

const useDevice = () => process.env.VAJRA_SIGNER === "device";

let shared: Promise<Device> | null = null;

/** One owner for the port: the board resets on open, and a second opener would fail anyway. */
export function theDevice(): Promise<Device> {
  shared ??= Device.open().catch((error) => {
    shared = null;
    throw error;
  });
  return shared;
}

export async function closeDevice() {
  const open = shared;
  shared = null;
  if (open) await (await open).close();
}

export interface Wallet {
  account: Address;
  harbor: Address;
  harborSalt: Hex;
}

// A device account and a software account are different accounts, and neither may displace the other. Nor may the emulator,
// which is why a test can run the device path without touching the account of a real board.
const walletFile = () => {
  if (!useDevice()) return "wallet.json";
  return process.env.VAJRA_DEVICE?.startsWith("emulator:") ? "wallet.emulator.json" : "wallet.device.json";
};
const walletPath = keyPath(walletFile());
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

/** Strictly above the sidecar's 0.01 minimum: the check that lets a staked entity read its own balance is a strict one. */
export const V2_STAKE = parseEther("0.012");

export async function createWallet(o: CreateOptions): Promise<Wallet> {
  if (loadWallet()) throw new Error("an account already exists on this machine");
  const device = useDevice() ? await theDevice() : null;
  const root = device ? (await device.info()).root : masterSigner().root;
  const harborSalt = bytesToHex(randomBytes(32));
  const { w16, v2, genesis } = deployments();
  // On the mirror an account is a V2 one, staked, because a pairing check needs the staked budget. The public devnet has no V2.
  const factory = v2?.factory ?? w16.factory;
  const funder = loadOrCreateKey(keyPath("deployer.key"));
  const config = {
    dailyKey: o.dailyKey,
    wotsRoot: root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(o.harbor, harborSalt),
    queueDelay: BigInt(o.queueDelay),
    coolingPeriod: BigInt(o.coolingPeriod),
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther(o.dailyLimit)],
    coolingAllowances: [parseEther(o.coolingAllowance)],
    ...(v2 ? { stake: V2_STAKE, unstakeDelay: 86_400 } : {}),
  };
  const account = await predictAccount(factory, config);
  // Pairing comes first, so a missed press cannot leave a funded account that no signer answers for.
  if (device) await device.pair(account, DEVNET.chainId, genesis);
  await createAccount(funder, factory, config, parseEther(o.fund));
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

/** The device path: it gets the whole unsigned transaction, and decides for itself what it is being asked to sign. */
async function runOnDevice(request: MasterOp, log: (line: string) => void): Promise<MasterResult> {
  const wallet = requireWallet();
  const device = await theDevice();
  const info = await device.info();
  const state = await accountState(wallet.account);
  if (state.wotsRoot.toLowerCase() !== info.root.toLowerCase()) throw new ChainStateUnknown(info.root, state.wotsRoot);

  const rotating = request.op === "rotate";
  const next = rotating ? await device.nextRoot() : null;
  const leaf = await claimLeaf({ root: info.root, leaf: info.left === 0 ? ROTATION_LEAF : info.next, account: wallet.account, op: request.op, canSkip: false, log });
  const { tx, hashes, digest } = prepareMasterTx({
    root: info.root,
    leaf,
    params: WOTS_W16,
    account: wallet.account,
    epochSalt: state.epochSalt,
    calls: [rotating ? ops.rotateRoot(next!) : callFor(request, wallet)],
    maxHashes: MAX_HASHES,
  });
  log(`confirm on the signer: ${request.op}`);
  const blob = await device.sign(encodeTx(tx));
  // The leaf is already spent by now. This is about the error: here it names the signer, and a mempool would only say "bad signature".
  if (!verifyMasterSignature(WOTS_W16, hexToBytes(digest), hexToBytes(blob), hexToBytes(info.root))) throw new Error("the signer returned a signature that does not verify");
  const use = { root: info.root, leaf, account: wallet.account, digest, signature: blob, op: request.op };
  const { hash, receipt } = await submit(withMasterSignature(tx, blob), { log }).catch(async (error: Error) => {
    // Refused or lost, the signature has still been revealed, and that is what the record is for.
    await publishUse(use, log);
    throw error;
  });
  await publishUse({ ...use, txHash: hash }, log);
  if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed`);
  if (rotating) {
    log("confirm on the signer: switch to the new tree");
    await device.rotated(next!);
  }
  const after = await device.info();
  return { hash, block: Number(receipt.blockNumber), verifyGas: Number(BigInt(receipt.frameReceipts[0]!.gasUsed)), leaf, hashes, leavesLeft: after.left };
}

/** Signs and lands one master operation. Refuses before signing if the chain's root is not this signer's. */
export async function runMasterOp(request: MasterOp, log: (line: string) => void = () => {}): Promise<MasterResult> {
  if (useDevice()) return runOnDevice(request, log);
  const wallet = requireWallet();
  const signer = masterSigner();
  const { epochSalt } = await assertRootMatches(signer, wallet.account);

  const rotating = request.op === "rotate";
  const next = rotating ? new MasterSigner(WOTS_W16, fileStore(nextSignerPath), newSeed) : null;
  const call = rotating ? ops.rotateRoot(next!.root) : callFor(request, wallet);
  // The reserved leaf is for when the ordinary ones are gone; a rotation before that uses an ordinary one.
  const rotation = rotating && signer.leavesLeft === 0;
  const leaf = await claimLeaf({ root: signer.root, leaf: signer.nextLeaf(rotation), account: wallet.account, op: request.op, canSkip: !rotation, log });
  const signed = signMasterTx({ signer, account: wallet.account, epochSalt, calls: [call], rotation, leaf, maxHashes: MAX_HASHES });
  const use = { root: signer.root, leaf, account: wallet.account, digest: signed.digest, signature: signer.sign(leaf, signed.digest), op: request.op };
  const { hash, receipt } = await submit(signed.tx, { log }).catch(async (error: Error) => {
    await publishUse(use, log);
    throw error;
  });
  await publishUse({ ...use, txHash: hash }, log);
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

/** One master transaction, for a call that is not in `MasterOp`: the mirror's V2 operations. Software signer only. */
export async function runCalls(calls: Call[], op: string, log: (line: string) => void = () => {}): Promise<MasterResult> {
  if (useDevice()) throw new Error("the hardware signer does not know this operation, and it signs nothing it cannot show");
  const wallet = requireWallet();
  const signer = masterSigner();
  const { epochSalt } = await assertRootMatches(signer, wallet.account);
  const leaf = await claimLeaf({ root: signer.root, leaf: signer.nextLeaf(false), account: wallet.account, op, canSkip: true, log });
  const signed = signMasterTx({ signer, account: wallet.account, epochSalt, calls, leaf, maxHashes: MAX_HASHES });
  const use = { root: signer.root, leaf, account: wallet.account, digest: signed.digest, signature: signer.sign(leaf, signed.digest), op };
  const { hash, receipt } = await submit(signed.tx, { log }).catch(async (error: Error) => {
    await publishUse(use, log);
    throw error;
  });
  await publishUse({ ...use, txHash: hash }, log);
  if (!framesSucceeded(receipt)) throw new Error(`${hash} was mined but a frame failed`);
  return { hash, block: Number(receipt.blockNumber), verifyGas: Number(BigInt(receipt.frameReceipts[0]!.gasUsed)), leaf: signed.leaf, hashes: signed.hashes, leavesLeft: signer.leavesLeft };
}

export interface WalletStatus {
  signer: "software" | "esp32" | "emulator";
  connected: boolean;
  root: Hex | null;
  leavesLeft: number | null;
  harbor: Address | null;
  account: Address | null;
  rootMatches: boolean | null;
  /** The leaf the next operation would use. */
  nextLeaf: number | null;
  /** The wallet writing to the leaf registry on Arkiv, if there is one. */
  registryWriter: Address | null;
}

export async function walletStatus(): Promise<WalletStatus> {
  const wallet = loadWallet();
  const harbor = wallet?.harbor ?? null;
  const account = wallet?.account ?? null;
  const known = async (root: Hex) => (wallet ? (await accountState(wallet.account)).wotsRoot.toLowerCase() === root.toLowerCase() : null);
  const registryWriter = theRegistry()?.address ?? null;

  if (useDevice()) {
    try {
      const info = await (await theDevice()).info();
      return { signer: info.kind, connected: true, root: info.root, leavesLeft: info.left, harbor, account, rootMatches: await known(info.root), nextLeaf: info.next, registryWriter };
    } catch {
      // An unplugged signer is a state of its own: nothing about its keys can be claimed.
      return { signer: "esp32", connected: false, root: null, leavesLeft: null, harbor, account, rootMatches: null, nextLeaf: null, registryWriter };
    }
  }
  const signer = masterSigner();
  return { signer: "software", connected: true, root: signer.root, leavesLeft: signer.leavesLeft, harbor, account, rootMatches: await known(signer.root), nextLeaf: ROTATION_LEAF - signer.leavesLeft, registryWriter };
}

export const dailyKeyPath = keyPath("daily.key");
export const localDailyKey = () => loadOrCreateKey(dailyKeyPath);
export const localDailyAddress = () => privateKeyToAccount(localDailyKey()).address;
