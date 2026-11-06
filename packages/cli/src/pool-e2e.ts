/**
 * The pool as a person lives with it, on the mirror: notes rebuilt from one seed after the machine is gone, and a meter that says how little
 * the pool hides. The real commands, in folders of their own, against the real chain. Every attack is really sent, and has to die with its
 * name. `vajra shielded` is the pool's own proof and attacks; this is what happens around them.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, formatEther, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, LEGACY_GAS_PRICE, deployments, isLocalStack, poolMeter, publicClient, readPoolFacts, unshieldTx, waitForSuccess, walletFor } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { noteFromSeed, proveUnshield, stopProver } from "./proving.ts";
import { denomination, noteFee, poolLeaves, readPool } from "./shield.ts";
import { check, newAccount, newSigner, refusals, refused, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this run spends notes on purpose: it runs on the mirror only, with VAJRA_STACK=local");

const started = Date.now();
const chainId = DEVNET.chainId;
const DENOM = denomination();
const PAID = DENOM - noteFee();
const dir = mkdtempSync(join(tmpdir(), "vajra-pool-"));
mkdirSync(join(dir, "anyone"));
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const deployer = loadOrCreateKey(keyPath("deployer.key"));

const steps: { step: string; hash: Hex | null }[] = [];

/** The real command, in a folder of its own, which is what a second machine is. */
const vajra = (state: string, args: string[]) =>
  spawnSync(process.execPath, [new URL("./main.ts", import.meta.url).pathname, ...args], { env: { ...process.env, VAJRA_STATE_DIR: state }, encoding: "utf8" });

/** Has to finish, and is recorded with the transaction it mined. */
function done(step: string, state: string, args: string[]) {
  const run = vajra(state, args);
  const hash = (/mined (0x[0-9a-f]{64})/.exec(run.stdout)?.[1] ?? null) as Hex | null;
  steps.push({ step, hash });
  check(run.status === 0, `${step}${hash ? `: ${hash}` : ""}${run.status === 0 ? "" : `: ${run.stderr.trim().slice(0, 200)}`}`);
  return run.stdout;
}

/** Has to stop, and say why. */
function stops(attack: string, state: string, args: string[], want: string) {
  const run = vajra(state, args);
  const said = `${run.stdout}\n${run.stderr}`;
  const ok = run.status !== 0 && said.includes(want);
  check(ok, `${attack}: ${ok ? want : said.trim().slice(0, 200)}`);
  refusals.push({ attack, refusal: ok ? want : said.trim().slice(0, 200) });
}

const line = (text: string, what: RegExp) => what.exec(text)?.[0] ?? "";

async function newHome(name: string) {
  const key = generatePrivateKey();
  const eoa = privateKeyToAccount(key).address;
  await waitForSuccess(await walletFor(deployer).sendTransaction({ to: eoa, value: parseEther("2"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "funding the EOA");
  const keyFile = join(dir, `${name}.key.txt`);
  writeFileSync(keyFile, key, { mode: 0o600 });
  const state = join(dir, name);
  mkdirSync(state);
  const harbor = fresh();
  const made = vajra(state, ["move", "--key-file", keyFile, "--harbor", harbor, "--delay", "60", "--cooling", "30"]);
  if (made.status !== 0) throw new Error(made.stderr);
  return { state, harbor, account: (JSON.parse(readFileSync(join(state, "wallet.json"), "utf8")) as { account: Address }).account };
}

async function outsider(name: string) {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  await waitForSuccess(await walletFor(deployer).sendTransaction({ to: address, value: parseEther("0.5"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "funding an outsider");
  const keyFile = join(dir, `${name}.key.txt`);
  writeFileSync(keyFile, key, { mode: 0o600 });
  const state = join(dir, name);
  mkdirSync(state);
  return { state, keyFile, address };
}

const held = (account: Address) => readPool<bigint>(account, "poolHeld");

const readings: { stage: string; state: string; deposits: number; withdrawn: number; left: number; addresses: number | null; said: string }[] = [];

/** What `vajra pool` says, for anyone, with no key and from a folder with nothing in it. */
async function meter(stage: string, account: Address, want: string) {
  const run = vajra(join(dir, "anyone"), ["pool", account]);
  const said = run.stdout.split("\n")[0] ?? "";
  const { state, deposits, withdrawn, left, addresses } = poolMeter((await readPoolFacts(account))!);
  readings.push({ stage, state, deposits, withdrawn, left, addresses, said });
  check(run.status === 0 && said.includes(want), `${stage}: ${said || run.stderr.trim().slice(0, 200)}`);
  return run.stdout;
}

console.log("\n1. Notes in, all from one seed");
const { state: home, account, harbor } = await newHome("home");
console.log(`  account ${account}`);
done("the owner shields note 0", home, ["shield"]);
done("the owner shields note 1", home, ["shield"]);
await meter("an owner alone in the pool, with two notes", account, "Hides nothing. Every note came from this account");
const friend = await outsider("friend");
done("an outsider pays in, from a key and a seed of their own", friend.state, ["shield", "--account", account, "--key-file", friend.keyFile]);
await meter("one outsider in the pool", account, "Hides little. A withdrawal could have been paid for by any of at most 2 addresses");
done("the owner shields note 2", home, ["shield"]);
const odds = await meter("three of four from the owner", account, "at most 2 addresses");
check(odds.includes("right about 3 times in 4"), "the meter says a guess at the largest depositor is right 3 times in 4");
check(odds.includes("Whether those addresses are different people") && odds.includes("not that"), "it says what no chain can show, and that the account's payment is not hidden");
check((await poolLeaves(account)).length === 4, "the pool holds four deposits");
const paidFirst = fresh();
const spoke = done("the owner spends the oldest note", home, ["unshield", paidFirst]);
check(spoke.includes("Hides little."), "the owner is told what the pool hides before the proof is made");
check((await publicClient.getBalance({ address: paidFirst })) === PAID, `the recipient holds ${formatEther(PAID)} ETH`);
await meter("after a withdrawal", account, "at most 2 addresses");

console.log("\n1b. A meter must not turn not knowing into a number");
const dead = spawnSync(process.execPath, [new URL("./main.ts", import.meta.url).pathname, "pool", account], { env: { ...process.env, VAJRA_STATE_DIR: join(dir, "anyone"), VAJRA_LANE: "9" }, encoding: "utf8" });
check(dead.status !== 0 && !/notes? paid in|Hides|\b0\b notes|has no pool/.test(dead.stdout), `a chain that does not answer gives no figure and no verdict: ${dead.stderr.trim().slice(0, 80)}`);
const noCode = vajra(join(dir, "anyone"), ["pool", fresh()]);
check(noCode.stdout.includes("has no pool") && !noCode.stdout.includes("Hides"), "an address with no code has no pool, which is not an empty pool");
const v1 = await newAccount(deployer, newSigner(), fresh(), fresh(), keccak256(toHex("v1")), parseEther("0.1"), deployments().w16.factory);
const v1Run = vajra(join(dir, "anyone"), ["pool", v1]);
check(v1Run.stdout.includes("has no pool"), "a V1 account, which reverts, has no pool, and that is not a failed read");
const bare = await newHome("bare");
await meter("a V2 account nobody has paid into", bare.account, "Nothing has been paid in");

console.log("\n2. A failed deposit leaves a gap, and the seed walks over it");
done("freeze", home, ["freeze"]);
stops("A deposit while frozen", home, ["shield"], "a frame failed");
done("unfreeze", home, ["unfreeze"]);
done("the owner shields again, past the number that failed", home, ["shield"]);

console.log("\n3. The machine is gone. The seed is on paper");
const paper = join(dir, "paper.txt");
copyFileSync(join(home, "note-seed.key"), paper);
const seed = readFileSync(paper, "utf8").trim() as Hex;
const laptop = join(dir, "new-laptop");
mkdirSync(laptop);
const empty = vajra(laptop, ["notes", "--account", account]);
check(empty.status === 0 && empty.stdout.includes("says nothing about the chain"), "a new machine knows nothing, and does not call that none");
stops("Spending with no notes on this machine", laptop, ["unshield", fresh(), "--account", account], "no unspent note on this machine");
const rebuilt = done("rebuild every note from the seed and the chain", laptop, ["notes-restore", "--seed-file", paper, "--account", account]);
check(rebuilt.includes("4 notes found in 5 deposits: 1 spent, 3 in the pool"), `the rebuild found them all: ${line(rebuilt, /\d+ notes found.*/)}`);
const paidRebuilt = fresh();
done("a rebuilt note is spent from the new machine", laptop, ["unshield", paidRebuilt, "--account", account]);
check((await publicClient.getBalance({ address: paidRebuilt })) === PAID, `the recipient holds ${formatEther(PAID)} ETH`);
const twice = done("rebuilding again is safe, and sees that spend", laptop, ["notes-restore", "--account", account]);
check(twice.includes("4 notes found in 5 deposits: 2 spent, 2 in the pool"), line(twice, /\d+ notes found.*/));
done("the new machine shields, and carries on from the seed's next number", laptop, ["shield", "--account", account, "--key-file", friend.keyFile]);

console.log("\n4. What a seed cannot do");
const stranger = join(dir, "stranger");
mkdirSync(stranger);
const wrongPaper = join(dir, "wrong-paper.txt");
writeFileSync(wrongPaper, generatePrivateKey());
const wrong = done("another seed", stranger, ["notes-restore", "--seed-file", wrongPaper, "--account", account]);
check(wrong.includes("0 notes found in 6 deposits"), "another seed finds nothing");
const friendPaper = join(dir, "friend-paper.txt");
copyFileSync(join(friend.state, "note-seed.key"), friendPaper);
const friendMachine = join(dir, "friend-machine");
mkdirSync(friendMachine);
const theirs = done("the outsider's seed finds the outsider's note and no other", friendMachine, ["notes-restore", "--seed-file", friendPaper, "--account", account]);
check(theirs.includes("1 notes found in 6 deposits"), line(theirs, /\d+ notes found.*/));
const elsewhere = join(dir, "elsewhere");
mkdirSync(elsewhere);
const { account: otherAccount } = await newHome("other");
const otherAccountRun = done("the right seed, on another account", elsewhere, ["notes-restore", "--seed-file", paper, "--account", otherAccount]);
check(otherAccountRun.includes("0 notes found"), "a seed's notes are the account's: the same seed elsewhere finds nothing here");
stops("A restore over a different seed on this machine", laptop, ["notes-restore", "--seed-file", wrongPaper, "--account", account], "a different note seed is already");
const junk = join(dir, "junk.txt");
writeFileSync(junk, "not a seed");
stops("A paper that is not a seed", join(dir, "another"), ["notes-restore", "--seed-file", junk, "--account", account], "that is not a note seed");
const spent = noteFromSeed(seed, account, chainId, 0);
const leaves = await poolLeaves(account);
const proved = await proveUnshield({ note: spent, leaves, leaf: leaves.indexOf(BigInt(JSON.parse(readFileSync(join(laptop, "notes.json"), "utf8")).find((n: { index: number }) => n.index === 0).commitment)), recipient: fresh(), denomination: DENOM, account, chainId });
await refused("A rebuilt note the chain has seen spent, sent again", { ...unshieldTx({ account, root: proved.root, nullifierHash: proved.nullifierHash, recipient: fresh(), proof: proved.proof }), nonceSeq: 1n }, "NullifierSpent");

console.log("\n5. The master key changes, and the notes do not care");
done("rotate the master key", home, ["rotate"]);
const afterRotation = join(dir, "after-rotation");
mkdirSync(afterRotation);
const rotated = done("rebuild after the rotation", afterRotation, ["notes-restore", "--seed-file", paper, "--account", account]);
check(rotated.includes("5 notes found"), line(rotated, /\d+ notes found.*/));

console.log("\n6. A backup carries the seed");
const passFile = join(dir, "pass.txt");
writeFileSync(passFile, "correct horse battery staple", { mode: 0o600 });
const backupFile = join(dir, "home.backup");
done("back up", home, ["backup", "--out", backupFile, "--passphrase-file", passFile]);
check(!readFileSync(backupFile, "utf8").includes(seed.slice(2)), "the backup does not show the seed");
const restored = join(dir, "restored");
mkdirSync(restored);
done("restore on a fresh machine", restored, ["restore", "--in", backupFile, "--passphrase-file", passFile]);
const fromBackup = done("rebuild from what the backup restored", restored, ["notes-restore"]);
check(fromBackup.includes("5 notes found"), line(fromBackup, /\d+ notes found.*/));

console.log("\n7. A note from before there was a seed survives a rebuild");
const oldFile = join(restored, "notes.json");
const oldNotes = JSON.parse(readFileSync(oldFile, "utf8")) as { index?: number }[];
writeFileSync(oldFile, JSON.stringify([{ account, secret: "1", nullifierSeed: "2", commitment: "3", leaf: 0, spent: true }, ...oldNotes]));
done("rebuild over a file holding an older note", restored, ["notes-restore"]);
check((JSON.parse(readFileSync(oldFile, "utf8")) as { index?: number }[]).some((n) => n.index === undefined), "the older note is still in the file");

console.log("\n8. An escape takes the notes to the harbor, and a rebuild says so");
const heldBefore = await held(account);
done("escape", home, ["escape"]);
check((await publicClient.getBalance({ address: harbor })) >= heldBefore, `the harbor holds what the notes were owed, ${formatEther(heldBefore)} ETH`);
const swept = done("rebuild after the escape", join(dir, "after-rotation"), ["notes-restore", "--account", account]);
check(/swept to the harbor/.test(swept) && !/: in the pool/.test(swept), `no note reads as money still in the pool: ${line(swept, /\d+ notes found.*/)}`);
await meter("after the escape", account, "This pool is closed");

const record = {
  ranAt: new Date().toISOString(),
  stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
  chainId,
  genesis: deployments().genesis,
  implementation: deployments().v2!.implementation,
  account,
  denomination: DENOM.toString(),
  failures: tally.failures,
  steps,
  meter: readings,
  refusals,
};
writeFileSync(new URL("../../../docs/evidence/pool-latest.json", import.meta.url), JSON.stringify(record, null, 1) + "\n");
rmSync(dir, { recursive: true, force: true });
console.log(`\n${steps.filter((s) => s.hash).length} mined, ${refusals.length} refused, ${tally.failures} failures, ${Math.round((Date.now() - started) / 1000)}s`);
await stopProver();
process.exit(tally.failures ? 1 : 0);
