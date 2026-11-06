/**
 * Backup and restore on the mirror, with the real commands against the real chain. The account is a fresh one made by `vajra move`,
 * in a folder of its own, so the demo account's signer is never touched.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LEGACY_GAS_PRICE, accountState, isLocalStack, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { type BackupFile, chainSpentLeaves, decryptBackup, encryptBackup } from "./backup.ts";
import { keyPath } from "./deploy.ts";
import { check, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("run this on the mirror, with VAJRA_STACK=local");

const dir = mkdtempSync(join(tmpdir(), "vajra-backup-"));
const vajra = (stateDir: string, args: string[]) =>
  spawnSync(process.execPath, [new URL("./main.ts", import.meta.url).pathname, ...args], { env: { ...process.env, VAJRA_STATE_DIR: stateDir, VAJRA_BACKUP_PASSPHRASE: "" }, encoding: "utf8" });

const passFile = join(dir, "pass.txt");
const wrongFile = join(dir, "wrong.txt");
const PASSPHRASE = "correct horse battery staple";
writeFileSync(passFile, PASSPHRASE, { mode: 0o600 });
writeFileSync(wrongFile, "not the right passphrase", { mode: 0o600 });

async function newAccount(name: string) {
  const key = generatePrivateKey();
  const eoa = privateKeyToAccount(key).address;
  const funded = await walletFor(loadOrCreateKey(keyPath("deployer.key"))).sendTransaction({ to: eoa, value: parseEther("1"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  await waitForSuccess(funded, "funding the EOA");
  const keyFile = join(dir, `${name}.key.txt`);
  writeFileSync(keyFile, key, { mode: 0o600 });
  const state = join(dir, name);
  mkdirSync(state);
  const harbor = privateKeyToAccount(generatePrivateKey()).address;
  const made = vajra(state, ["move", "--key-file", keyFile, "--harbor", harbor, "--delay", "60", "--cooling", "30"]);
  if (made.status !== 0) throw new Error(made.stderr);
  return { state, account: (JSON.parse(readFileSync(join(state, "wallet.json"), "utf8")) as { account: Address }).account };
}

const backup = (state: string, out: string) => vajra(state, ["backup", "--out", out, "--passphrase-file", passFile]);
const restore = (state: string, file: string, ...extra: string[]) => vajra(state, ["restore", "--in", file, "--passphrase-file", passFile, ...extra]);

console.log("\n1. A backup is encrypted");
const { state, account } = await newAccount("home");
vajra(state, ["freeze"]);
vajra(state, ["unfreeze"]);
const first = join(dir, "first.backup");
const made = backup(state, first);
if (made.status !== 0) console.log(made.stderr);
check(made.status === 0, "vajra backup finished");
const seed = (JSON.parse(readFileSync(join(state, "signer.json"), "utf8")) as { seed: string }).seed;
const text = readFileSync(first, "utf8");
check(!text.includes(seed.slice(2)) && !text.includes(account.slice(2)), "the file shows neither the seed nor the account");
check(!made.stdout.includes(seed.slice(2)), "the seed was not printed");
check(backup(state, first).status !== 0, "a backup never replaces a file");

console.log("\n2. A restore with the wrong passphrase, or a changed file, is refused");
const wrong = vajra(join(dir, "elsewhere"), ["restore", "--in", first, "--passphrase-file", wrongFile]);
check(wrong.status !== 0 && wrong.stderr.includes("wrong passphrase"), "wrong passphrase");
const file = JSON.parse(text) as BackupFile;
const flipped = Buffer.from(file.data, "base64");
flipped[10]! ^= 1;
const damaged = join(dir, "damaged.backup");
writeFileSync(damaged, JSON.stringify({ ...file, data: flipped.toString("base64") }));
check(restore(join(dir, "elsewhere"), damaged).stderr.includes("wrong passphrase"), "one flipped bit");
const weakened = join(dir, "weakened.backup");
writeFileSync(weakened, JSON.stringify({ ...file, kdf: { ...file.kdf, N: 16_384 } }));
check(restore(join(dir, "elsewhere"), weakened).status !== 0, "weaker KDF settings written into the file");

console.log("\n3. A fresh machine: the restore proves itself, and the restored key signs");
const fresh = join(dir, "fresh");
const proved = restore(fresh, first);
console.log(proved.stdout.trim().split("\n").map((line) => `  ${line}`).join("\n"));
if (proved.status !== 0) console.log(proved.stderr);
check(proved.status === 0 && proved.stdout.includes(": match"), "the root from the seed matches the chain's");
const signed = vajra(fresh, ["freeze"]);
if (signed.status !== 0) console.log(signed.stderr);
check(signed.status === 0, "the restored signer's freeze was mined");
check((await accountState(account)).frozen, "the account is frozen on chain");
vajra(fresh, ["unfreeze"]);

console.log("\n4. The same backup is now stale, and is refused");
const chainLeaves = await chainSpentLeaves(account, (await accountState(account)).wotsRoot);
check(chainLeaves.length === 4, `the chain shows 4 spent leaves: ${chainLeaves.join(", ")}`);
const late = join(dir, "late");
const stale = restore(late, first);
check(stale.status !== 0 && stale.stderr.includes("stale leaf state"), `refused: ${stale.stderr.trim().slice(0, 110)}`);
check(!existsSync(join(late, "signer.json")), "nothing was written");
const checkOnly = restore(late, first, "--check");
check(checkOnly.status !== 0, "--check refuses it too");

console.log("\n5. A restore cannot go backwards over a newer signer on the disk");
cpSync(fresh, join(dir, "newer"), { recursive: true });
const backwards = restore(join(dir, "newer"), first);
check(backwards.status !== 0 && backwards.stderr.includes("stale leaf state"), "a newer signer is not replaced by an older backup");

console.log("\n6. Another account's key is refused by the root check");
const other = await newAccount("other");
const contents = await decryptBackup(file, PASSPHRASE);
const otherSigner = JSON.parse(readFileSync(join(other.state, "signer.json"), "utf8"));
const swapped = join(dir, "swapped.backup");
writeFileSync(swapped, JSON.stringify(await encryptBackup({ ...contents, signer: otherSigner }, PASSPHRASE)));
const foreign = restore(join(dir, "foreign"), swapped);
check(foreign.status !== 0 && foreign.stderr.includes("chain state unknown"), "the seed does not match the chain's root");

console.log("\n7. The only backup you have is stale: an explicit advance gets the key back without reusing a leaf");
const advancedDir = join(dir, "advanced");
const advanced = restore(advancedDir, first, "--advance-past-chain");
if (advanced.status !== 0) console.log(advanced.stderr);
check(advanced.status === 0 && advanced.stdout.includes("WARNING"), "it warns");
const next = JSON.parse(readFileSync(join(advancedDir, "signer.json"), "utf8")) as { nextLeaf: number };
check(next.nextLeaf === 4, `the next leaf is past everything the chain has seen: ${next.nextLeaf}`);
const again = vajra(advancedDir, ["freeze"]);
if (again.status !== 0) console.log(again.stderr);
check(again.status === 0, "it signs on a new leaf, and the chain takes it");
vajra(advancedDir, ["unfreeze"]);

console.log("\n8. A fresh backup of the current state restores cleanly");
const current = join(dir, "current.backup");
check(backup(advancedDir, current).status === 0, "backed up");
check(restore(join(dir, "last"), current).status === 0, "restored");

console.log(`\n${tally.failures} failures`);
process.exit(tally.failures ? 1 : 0);
