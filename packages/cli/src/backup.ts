/**
 * Encrypted backup of the software signer, and a restore that has to prove itself before it is allowed to replace anything.
 *
 * A restored one-time key is the most dangerous file this project has. An old copy of `signer.json` thinks leaves are unused that
 * have already signed, and the next signature from one of them gives away enough to forge. The signer's counter cannot catch this, because
 * the counter is what was restored. So a restore checks against what the backup cannot have forgotten:
 *
 *   the chain's root       the seed really is this account's master key
 *   the nonce manager      every leaf the chain has seen spent is one this state knows about
 *   the leaf registry      the same for leaves revealed and never mined, when one is configured
 *   the file on this disk  a restore never replaces a newer state, or a different key
 *
 * What it cannot see: a signature revealed and never mined, with no registry. That limit is printed each time.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Address, type Hex, concat, keccak256, numberToHex, pad, zeroHash } from "viem";
import {
  ChainStateUnknown,
  DEVNET,
  MasterSigner,
  ROTATION_LEAF,
  type SignerState,
  TREE_LEAVES,
  WOTS_W16,
  accountState,
  deployments,
  genesisHash,
  leafNonceKey,
  memoryStore,
  rpcBatch,
} from "@vajra/core";
import { fileStore } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { theRegistry } from "./registry.ts";
import { checkNoteSeed, installNoteSeed, localNoteSeed } from "./note-seed.ts";
import { withSignerLock } from "./signer-lock.ts";
import { type Wallet, loadWallet } from "./wallet.ts";

const MIN_PASSPHRASE = 12;
/** 2^17: about 128 MiB and a few tenths of a second, which is what OWASP asks of scrypt. */
const SCRYPT = { N: 131_072, r: 8, p: 1 };
const NONCE_MANAGER: Address = "0x0000000000000000000000000000000000008250";

export interface BackupFile {
  vajra: "backup";
  version: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  data: string;
}

export interface BackupContents {
  createdAt: string;
  chainId: number;
  genesis: Hex;
  wallet: Wallet;
  signer: SignerState;
  /** A rotation that was started and not finished. */
  nextSigner: SignerState | null;
  root: Hex;
  /** What every note comes from. A backup made before notes had a seed has none. */
  noteSeed?: Hex | null;
}

function deriveKey(passphrase: string, kdf: BackupFile["kdf"]): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(passphrase.normalize("NFKC"), Buffer.from(kdf.salt, "base64"), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

/** The header is authenticated too, so nobody can weaken the KDF settings in a file and leave it decrypting. */
const headerOf = (file: Pick<BackupFile, "vajra" | "version" | "kdf">) => Buffer.from(JSON.stringify([file.vajra, file.version, file.kdf]));

export async function encryptBackup(contents: BackupContents, passphrase: string, params = SCRYPT): Promise<BackupFile> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`a backup passphrase is at least ${MIN_PASSPHRASE} characters`);
  const kdf = { name: "scrypt" as const, ...params, salt: randomBytes(16).toString("base64") };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(passphrase, kdf), iv);
  cipher.setAAD(headerOf({ vajra: "backup", version: 1, kdf }));
  const data = Buffer.concat([cipher.update(JSON.stringify(contents), "utf8"), cipher.final()]);
  return { vajra: "backup", version: 1, kdf, cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") }, data: data.toString("base64") };
}

export async function decryptBackup(file: BackupFile, passphrase: string): Promise<BackupContents> {
  if (file.vajra !== "backup" || file.version !== 1 || file.kdf?.name !== "scrypt" || file.cipher?.name !== "aes-256-gcm") throw new Error("this is not a VAJRA backup, or it is a version this build cannot read");
  const decipher = createDecipheriv("aes-256-gcm", await deriveKey(passphrase, file.kdf), Buffer.from(file.cipher.iv, "base64"));
  decipher.setAAD(headerOf(file));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as BackupContents;
  } catch {
    throw new Error("REFUSED: wrong passphrase, or the file has been changed");
  }
}

/** Where EIP-8250 keeps a keyed nonce: the predeploy's storage, at keccak(sender ‖ key). Read off the live chain, and checked by `vajra backup-e2e`. */
const nonceSlot = (account: Address, key: bigint) => keccak256(concat([pad(account, { size: 32 }), numberToHex(key, { size: 32 })]));

/** Every leaf the chain has seen on this root. A failed read throws: unknown must not pass for unspent. */
export async function chainSpentLeaves(account: Address, root: Hex): Promise<number[]> {
  const leaves = Array.from({ length: TREE_LEAVES }, (_, leaf) => leaf);
  const values = await rpcBatch<Hex>(
    DEVNET.execution,
    leaves.map((leaf) => ({ method: "eth_getStorageAt", params: [NONCE_MANAGER, nonceSlot(account, leafNonceKey(root, leaf)), "latest"] })),
  );
  return leaves.filter((leaf) => BigInt(values[leaf]!) !== 0n);
}

export class StaleLeafState extends Error {
  readonly leaves: number[];

  constructor(leaves: number[], where: string) {
    super(`REFUSED: stale leaf state. ${where} shows leaf ${leaves.join(", ")} spent, and this backup does not know it. Signing from it could reveal a leaf twice.`);
    this.name = "StaleLeafState";
    this.leaves = leaves;
  }
}

const knownTo = (state: SignerState) => (leaf: number) => state.revealed[leaf] !== undefined;

export interface RestoreProof {
  account: Address;
  rootFromSeed: Hex;
  rootOnChain: Hex;
  spentOnChain: number[];
  knownToBackup: number;
  nextLeaf: number;
  leavesLeft: number;
  registry: string;
  advanced: number[];
}

/**
 * Everything has to hold before a file is touched. `advance` is for the one backup you have being out of date: it marks the leaves
 * the chain knows as used, so they can never sign again, instead of refusing.
 */
export async function proveRestore(contents: BackupContents, options: { advance?: boolean } = {}): Promise<{ proof: RestoreProof; signer: SignerState }> {
  const { wallet } = contents;
  if (contents.chainId !== DEVNET.chainId) throw new Error(`REFUSED: this backup is from chain ${contents.chainId}, and this is chain ${DEVNET.chainId}`);
  const genesis = await genesisHash();
  if (contents.genesis !== genesis) throw new Error(`REFUSED: this backup is from a chain with genesis ${contents.genesis}, and this one has ${genesis}`);

  const seedSigner = new MasterSigner(WOTS_W16, memoryStore(structuredClone(contents.signer)), () => {
    throw new Error("a backup always holds a seed");
  });
  const rootFromSeed = seedSigner.root;
  const { wotsRoot: rootOnChain } = await accountState(wallet.account);
  if (rootFromSeed.toLowerCase() !== rootOnChain.toLowerCase()) throw new ChainStateUnknown(rootFromSeed, rootOnChain);

  const spentOnChain = await chainSpentLeaves(wallet.account, rootFromSeed);
  const registry = theRegistry();
  const snapshot = registry ? await registry.snapshot(rootFromSeed, { patience: 45_000 }) : null;
  const usedInRegistry = snapshot?.uses.map((use) => use.leaf) ?? [];
  const registryNote = !registry ? "not configured, so a signature revealed and never mined cannot be seen" : snapshot ? `${snapshot.uses.length} verified uses` : "did not answer, so a signature revealed and never mined cannot be seen";

  const known = knownTo(contents.signer);
  const missingChain = spentOnChain.filter((leaf) => !known(leaf));
  const missingRegistry = usedInRegistry.filter((leaf) => !known(leaf));
  if (!options.advance) {
    if (missingChain.length) throw new StaleLeafState(missingChain, "The chain");
    if (missingRegistry.length) throw new StaleLeafState(missingRegistry, "The leaf registry");
  }

  const advanced = [...new Set([...missingChain, ...missingRegistry])].sort((a, b) => a - b);
  const revealed = { ...contents.signer.revealed };
  // A digest no signature can have: `sign` then refuses this leaf for every real one.
  for (const leaf of advanced) revealed[leaf] = zeroHash;
  const ordinary = advanced.filter((leaf) => leaf !== ROTATION_LEAF);
  const nextLeaf = Math.max(contents.signer.nextLeaf, ...ordinary.map((leaf) => leaf + 1));
  const signer: SignerState = { ...contents.signer, nextLeaf, revealed };

  return {
    signer,
    proof: {
      account: wallet.account,
      rootFromSeed,
      rootOnChain,
      spentOnChain,
      knownToBackup: Object.keys(contents.signer.revealed).length,
      nextLeaf,
      leavesLeft: Math.max(0, ROTATION_LEAF - nextLeaf),
      registry: registryNote,
      advanced,
    },
  };
}

/** A restore over the top of a live signer: it may only add knowledge. */
function checkLocal(restored: SignerState, signerPath: string) {
  const local = fileStore(signerPath).load();
  if (!local) return;
  if (local.seed !== restored.seed) throw new Error("REFUSED: a different key is already on this machine. Move it aside first: it may be the only copy.");
  const lost = Object.keys(local.revealed).map(Number).filter((leaf) => restored.revealed[leaf] === undefined);
  if (lost.length) throw new StaleLeafState(lost, "The signer on this machine");
}

async function passphrase(flags: Record<string, string>, confirm: boolean): Promise<string> {
  if (flags["passphrase-file"]) return readFileSync(flags["passphrase-file"], "utf8").replace(/\r?\n$/, "");
  if (process.env.VAJRA_BACKUP_PASSPHRASE) return process.env.VAJRA_BACKUP_PASSPHRASE;
  if (!process.stdin.isTTY) throw new Error("no passphrase: use --passphrase-file, or run this in a terminal");
  const ask = async (question: string) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Keeps the characters off the screen.
    (reader as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
      if (text.includes(question)) process.stdout.write(text);
    };
    const answer = await reader.question(question);
    reader.close();
    process.stdout.write("\n");
    return answer;
  };
  const first = await ask("Backup passphrase: ");
  if (confirm && first !== (await ask("Again: "))) throw new Error("the two passphrases differ");
  return first;
}

function refuseDevice() {
  if (process.env.VAJRA_SIGNER !== "device") return;
  const seed = localNoteSeed() ? ` Your note seed is on this machine and this does not take it: copy ${keyPath("note-seed.key")} to paper or steel yourself.` : "";
  throw new Error(`the master key is on the hardware signer, so a backup has nothing of it to take.${seed}`);
}

export async function backupCommand(flags: Record<string, string>) {
  refuseDevice();
  const wallet = loadWallet();
  if (!wallet) throw new Error("no account here to back up");
  const out = flags.out;
  if (!out) throw new Error("usage: vajra backup --out <file> [--passphrase-file <file>]");
  if (existsSync(out) && flags.force === undefined) throw new Error(`${out} exists. A backup never replaces a file: choose another name`);
  const secret = await passphrase(flags, true);

  // In the lock, so that this is never a picture of a signer halfway through a signature.
  const contents = await withSignerLock(async () => {
    const signer = fileStore(keyPath("signer.json")).load();
    if (!signer) throw new Error("no signer here to back up");
    return {
      createdAt: new Date().toISOString(),
      chainId: DEVNET.chainId,
      genesis: deployments().genesis,
      wallet,
      signer,
      nextSigner: fileStore(keyPath("signer.next.json")).load() ?? null,
      root: new MasterSigner(WOTS_W16, memoryStore(structuredClone(signer)), () => new Uint8Array()).root,
      noteSeed: localNoteSeed(),
    } satisfies BackupContents;
  });
  const { proof } = await proveRestore(contents);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(await encryptBackup(contents, secret), null, 1), { mode: 0o600 });
  renameSync(`${out}.tmp`, out);
  console.log(`backed up account ${wallet.account}\nroot ${proof.rootFromSeed}, matches the chain\n${proof.knownToBackup} leaves used, next leaf ${proof.nextLeaf}\nwritten ${out}`);
  console.log("This goes stale with your next master operation. Back up again after using the key.");
  if (!contents.noteSeed) console.log("There is no note seed here yet, so this holds none. Back up again after your first vajra shield.");
}

export async function restoreCommand(flags: Record<string, string>) {
  refuseDevice();
  const input = flags.in;
  if (!input) throw new Error("usage: vajra restore --in <file> [--passphrase-file <file>] [--check] [--advance-past-chain]");
  const contents = await decryptBackup(JSON.parse(readFileSync(input, "utf8")) as BackupFile, await passphrase(flags, false));
  const { proof, signer } = await proveRestore(contents, { advance: flags["advance-past-chain"] !== undefined });

  console.log(`account            ${proof.account}`);
  console.log(`root from the seed ${proof.rootFromSeed}`);
  console.log(`root on the chain  ${proof.rootOnChain}: match`);
  console.log(`spent on the chain ${proof.spentOnChain.length ? proof.spentOnChain.join(", ") : "none"}: all known to this state`);
  console.log(`leaf registry      ${proof.registry}`);
  console.log(`next leaf          ${proof.nextLeaf}, ${proof.leavesLeft} left`);
  if (proof.advanced.length) console.log(`WARNING: the backup was stale. Leaves ${proof.advanced.join(", ")} are now marked as used. A signature revealed and never mined still cannot be seen, so rotate to a new tree soon.`);
  if (flags.check !== undefined) return console.log("proved, and nothing written: --check");

  await withSignerLock(async () => {
    const signerPath = keyPath("signer.json");
    checkLocal(signer, signerPath);
    // Before anything is written: a refusal here must not leave half a restore.
    if (contents.noteSeed) checkNoteSeed(contents.noteSeed);
    mkdirSync(dirname(signerPath), { recursive: true });
    fileStore(signerPath).save(signer);
    if (contents.nextSigner) fileStore(keyPath("signer.next.json")).save(contents.nextSigner);
    writeFileSync(keyPath("wallet.json"), JSON.stringify(contents.wallet, null, 1), { mode: 0o600 });
    if (contents.noteSeed) installNoteSeed(contents.noteSeed);
  });
  console.log(`restored to ${dirname(keyPath("signer.json"))}`);
  if (contents.noteSeed) console.log("note seed restored: `vajra notes-restore` finds your notes on the chain");
}
