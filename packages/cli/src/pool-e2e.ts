/**
 * The pool as a person lives with it, on the mirror: notes rebuilt from one seed after the machine is gone, a meter that says how little the
 * pool hides, and a failed payment that stays money. The real commands, in folders of their own, against the real chain. Every attack is
 * really sent, and has to die with its name. `vajra shielded` is the pool's own proof and attacks; this is what happens around them.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, concat, formatEther, keccak256, numberToHex, parseEther, size, toFunctionSelector, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  type FlatProof,
  LEGACY_GAS_PRICE,
  accountState,
  accountV2Abi,
  checkRescue,
  claimCall,
  deployments,
  framesSucceeded,
  isLocalStack,
  maxGas,
  ops,
  opsV2,
  parseRescue,
  poolMeter,
  publicClient,
  readPoolFacts,
  sendRescue,
  signDaily,
  simulateFrames,
  submit,
  unshieldTx,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { type Note, noteCommitment, noteFromSeed, noteNullifier, proveUnshield, stopProver } from "./proving.ts";
import { CLAIM_GAS, denomination, noteFee, poolLeaves, readPool } from "./shield.ts";
import { check, deployRefuser, evidence, master, mined, newAccount, newSigner, preFixV2Factory, refusals, refused, tally } from "./zk-run.ts";

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
const failedNote = done("this machine's own record of it", home, ["notes"]);
check(failedNote.includes("not in the pool: its deposit failed"), "a note whose deposit failed does not read as money in the pool");
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
const typo = done("the right seed, on the machine that just tried the wrong one", stranger, ["notes-restore", "--seed-file", paper, "--account", account]);
check(typo.includes("5 notes found"), "a wrong paper was not kept, so it cannot lock the right one out");
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

/** Runtime bytes, placed as they stand. */
async function place(runtime: Hex): Promise<Address> {
  const length = numberToHex(size(runtime), { size: 1 });
  const hash = await walletFor(deployer).sendTransaction({ data: concat(["0x60", length, "0x600a5f3960", length, "0x5ff3", runtime]), gas: 1_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  return (await waitForSuccess(hash, "placing a recipient")).contractAddress!;
}

/** Refuses money until anything sends it data, and takes it from then on. */
const RELENTS = "0x36600c575f546012575f5ffd5b60015f55005b00";
/** Refuses with a 450,000-byte revert, to make the caller copy it. */
const REVERT_BOMB = "0x6206ddd05ffd";
/** Writes new slots until it dies, to leave the frame no state gas. */
const STATE_EATER = "0x60015b808055600101600256";

const free = async (account: Address) => (await publicClient.getBalance({ address: account })) - (await held(account));
const claimed: { step: string; hash: Hex; gas: number }[] = [];

/** A claim is an ordinary transaction, so it is mined whatever happens. This one has to revert, with this name, and the account must not pay. */
async function claimDies(attack: string, account: Address, want: string, a: { proof: FlatProof; root: bigint; nullifierHash: bigint; recipient: Address }) {
  const data = claimCall(a);
  const [balanceBefore, heldBefore] = [await publicClient.getBalance({ address: account }), await held(account)];
  const named = await publicClient.simulateContract({ address: account, abi: accountV2Abi as never, functionName: "claim", args: [a.proof, a.root, a.nullifierHash, a.recipient], account: privateKeyToAccount(deployer).address } as never).then(
    () => "allowed",
    (error: Error) => error.message,
  );
  const hash = await walletFor(deployer).sendTransaction({ to: account, data, gas: CLAIM_GAS, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  const { status } = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1000 });
  const untouched = (await publicClient.getBalance({ address: account })) === balanceBefore && (await held(account)) === heldBefore;
  const ok = status === "reverted" && named.includes(want) && untouched;
  check(ok, `${attack}: ${ok ? `${want}, mined as a revert, and the account paid nothing` : `${status}, ${named.slice(0, 160)}, untouched ${untouched}`}`);
  refusals.push({ attack, refusal: ok ? want : named.slice(0, 200) });
}

/** The real path of a claim, from whoever pays its gas. */
async function claimLands(step: string, account: Address, a: { proof: FlatProof; root: bigint; nullifierHash: bigint; recipient: Address }) {
  const hash = await walletFor(deployer).sendTransaction({ to: account, data: claimCall(a), gas: CLAIM_GAS, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  const receipt = await waitForSuccess(hash, step);
  claimed.push({ step, hash, gas: Number(receipt.gasUsed) });
  check(true, `${step}: ${hash}, ${receipt.gasUsed} gas, from the sender and not the account`);
}

const stateOf = async (account: Address, note: Note) => readPool<bigint>(account, "noteState", [await noteNullifier(note)]);
const proofOf = async (account: Address, note: Note, leaf: number, recipient: Address) => {
  const proved = await proveUnshield({ note, leaves: await poolLeaves(account), leaf, recipient, denomination: DENOM, account, chainId });
  return { ...proved, recipient };
};
const sendNote = (account: Address, p: Awaited<ReturnType<typeof proofOf>>) => unshieldTx({ account, root: p.root, nullifierHash: p.nullifierHash, recipient: p.recipient, proof: p.proof });

/** An account with a note on it, and a daily key a thief is holding. */
async function thiefAccount(label: string, factory: Address, fund: bigint) {
  const signer = newSigner();
  const dailyKey = generatePrivateKey();
  const daily = privateKeyToAccount(dailyKey).address;
  const safe = fresh();
  const salt = keccak256(toHex(label));
  const address = await newAccount(deployer, signer, daily, safe, salt, fund, factory);
  const { epochSalt } = await accountState(address);
  const owner = (calls: Parameters<typeof master>[3]) => master(signer, address, epochSalt, calls);
  const thief = (calls: Parameters<typeof signDaily>[0]["calls"]) => signDaily({ key: dailyKey, dailyKey: daily, account: address, calls });
  return { address, owner, thief, harbor: safe, salt };
}

async function depositNote(label: string, a: Awaited<ReturnType<typeof thiefAccount>>) {
  const note = noteFromSeed(generatePrivateKey(), a.address, chainId, 0);
  const commitment = await noteCommitment(note);
  await mined(label, a.owner([opsV2.shield(commitment, DENOM)]));
  return { note, leaf: (await poolLeaves(a.address)).indexOf(commitment) };
}

console.log("\n9. On the bytes before this change, a refused payment fell where a stolen daily key could spend it");
const before = await thiefAccount("before", await preFixV2Factory(deployer, "VajraAccountV2.pre-section-26"), parseEther("0.2"));
const oldNote = await depositNote("before: a note, with the master key", before);
const oldRefuser = await deployRefuser(deployer);
await mined("before: the note is paid to a contract that refuses it", sendNote(before.address, await proofOf(before.address, oldNote.note, oldNote.leaf, oldRefuser)));
check((await held(before.address)) === 0n, "before: nothing is held for it, and the holder has lost it");
const oldLoot = fresh();
await mined("before: the thief spends the note's money with the daily key", await before.thief([ops.spend(ETH, oldLoot, parseEther("0.15"))]));
check((await publicClient.getBalance({ address: oldLoot })) === parseEther("0.15"), "before: the thief holds 0.15 ETH, and 0.1 ETH of it was the note's");

console.log("\n10. Now the same thing stays held");
const after = await thiefAccount("after", deployments().v2!.factory, parseEther("0.2"));
const newNote = await depositNote("a note, with the master key", after);
const relents = await place(RELENTS);
const freeBefore = await free(after.address);
const refusedProof = await proofOf(after.address, newNote.note, newNote.leaf, relents);
const refusedTx = sendNote(after.address, refusedProof);
const refusal = await mined("the note is paid to a contract that refuses it", refusedTx);
check(framesSucceeded(refusal.receipt), "the frame still succeeds: a refused payment is not a mined failure");
check((await stateOf(after.address, newNote.note)) === 2n, "the note is spent and owed");
check((await held(after.address)) === PAID, `${formatEther(PAID)} ETH is held for it`);
const freeAfter = await free(after.address);
check(freeAfter >= freeBefore, `the note paid its own fee: the owner's free balance did not fall, ${formatEther(freeBefore)} to ${formatEther(freeAfter)} ETH`);
await refused("One note, the same proof sent again", { ...refusedTx, nonceSeq: 1n }, "NullifierSpent");
// Valid in VERIFY, so it is really mined, and has to fail in its frame. The name comes from the client's own trace of the same bytes.
const lootAddress = fresh();
const raid = await after.thief([ops.spend(ETH, lootAddress, parseEther("0.15"))]);
const traced = JSON.stringify(await simulateFrames(raid, "latest", true));
const named = traced.includes(toFunctionSelector("ValueNotConserved()").slice(2));
const raided = await submit(raid);
steps.push({ step: "the thief's same spend, mined with its frame failed", hash: raided.hash });
const kept = !framesSucceeded(raided.receipt) && (await publicClient.getBalance({ address: lootAddress })) === 0n && (await held(after.address)) === PAID;
check(named && kept, `The thief's same spend, really sent: ${named ? "ValueNotConserved" : "no name in the trace"}, its frame failed, and the thief holds nothing`);
refusals.push({ attack: "A daily spend reaching into a claim, really sent", refusal: named ? "ValueNotConserved, in the SENDER frame" : "no name in the trace" });
await refused("The daily key reaches for the claim with no proof", await after.thief([{ data: claimCall({ ...refusedProof }), execution: 500_000n, state: 200_000n }]), "EscapeKeyOutranks");
// As far as a spend can: the maximum cost is taken before the frame runs, so `_transfer` needs that much left. What comes back after is less than it.
const draft = await after.thief([ops.spend(ETH, fresh(), freeAfter - parseEther("0.003"))]);
const drained = (await free(after.address)) - maxGas(draft) * draft.fees.maxFeePerGas - 1_000_000_000_000n;
await mined("the thief spends the free balance down, as a spend may", await after.thief([ops.spend(ETH, fresh(), drained)]));
await refused("Fees reaching into a claim, with almost nothing free", await after.thief([ops.spend(ETH, fresh(), 1n)]), "ValueNotConserved");
// A master transaction's fee is not held to this: the master key can take the pool anyway. So the owner tops up before signing anything here.
await waitForSuccess(await walletFor(deployer).sendTransaction({ to: after.address, value: parseEther("0.3"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "topping the account up");

console.log("\n11. Nobody but the holder can move it");
const bent = [...refusedProof.proof] as unknown as bigint[];
bent[2] = bent[2]! ^ 1n;
const thiefAddress = fresh();
await claimDies("A corrupted proof", after.address, "ShieldProofInvalid", { ...refusedProof, proof: bent as unknown as FlatProof });
await claimDies("The seen proof, moved to a thief", after.address, "ShieldProofInvalid", { ...refusedProof, recipient: thiefAddress });
const elsewhereProof = await proveUnshield({ note: newNote.note, leaves: await poolLeaves(after.address), leaf: newNote.leaf, recipient: thiefAddress, denomination: DENOM, account: fresh(), chainId });
await claimDies("A proof made for another account", after.address, "ShieldProofInvalid", { proof: elsewhereProof.proof, root: refusedProof.root, nullifierHash: refusedProof.nullifierHash, recipient: thiefAddress });
const biggerProof = await proveUnshield({ note: newNote.note, leaves: await poolLeaves(after.address), leaf: newNote.leaf, recipient: thiefAddress, denomination: DENOM * 2n, account: after.address, chainId });
await claimDies("A proof claiming a larger denomination", after.address, "ShieldProofInvalid", { proof: biggerProof.proof, root: refusedProof.root, nullifierHash: refusedProof.nullifierHash, recipient: thiefAddress });
// Someone who learned the nullifier seed and not the secret can make a real proof, in a tree of their own. Only the root stops it.
const half: Note = { secret: 12345n, nullifierSeed: newNote.note.nullifierSeed };
const ownTree = await proveUnshield({ note: half, leaves: [await noteCommitment(half)], leaf: 0, recipient: thiefAddress, denomination: DENOM, account: after.address, chainId });
await claimDies("Half a note, proved in a tree of the thief's own", after.address, "RootUnknown", { proof: ownTree.proof, root: ownTree.root, nullifierHash: ownTree.nullifierHash, recipient: thiefAddress });
await claimDies("The first recipient, which still refuses", after.address, "TransferFailed", refusedProof);
const another = await depositNote("a second note, never spent", after);
const unspentProof = await proofOf(after.address, another.note, another.leaf, fresh());
await claimDies("A note that was never spent, to take it without a fee", after.address, "NothingOwed", unspentProof);
await mined("freeze", after.owner([ops.freeze()]));
const newProof = await proofOf(after.address, newNote.note, newNote.leaf, fresh());
await claimDies("A freeze stops a claim", after.address, "AccountFrozen", newProof);
await mined("unfreeze", after.owner([ops.unfreeze()]));
const balanceBefore = await publicClient.getBalance({ address: newProof.recipient });
await claimLands("the holder claims, to a new address, with a new proof", after.address, newProof);
check((await publicClient.getBalance({ address: newProof.recipient })) - balanceBefore === PAID, `the new address holds ${formatEther(PAID)} ETH`);
check((await held(after.address)) === DENOM, "only the other note is held now");
await claimDies("The same claim again", after.address, "NothingOwed", newProof);
await waitForSuccess(await walletFor(deployer).sendTransaction({ to: relents, data: "0x01", gas: 200_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "the first recipient relents");
await claimDies("The first proof, public since it failed, once its recipient takes money", after.address, "NothingOwed", refusedProof);
await mined("the second note leaves as usual", sendNote(after.address, unspentProof));
await claimDies("A note that was paid", after.address, "NothingOwed", unspentProof);
// A limit, held here so that the docs cannot overstate it: the first proof is public, and it stays good for the address it names.
const third = await depositNote("a third note", after);
const relentsLater = await place(RELENTS);
const thirdProof = await proofOf(after.address, third.note, third.leaf, relentsLater);
await mined("it goes to a contract that refuses it", sendNote(after.address, thirdProof));
await waitForSuccess(await walletFor(deployer).sendTransaction({ to: relentsLater, data: "0x01", gas: 200_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "that contract relents");
await claimLands("a stranger sends the public first proof, and it pays the address it names", after.address, thirdProof);
check((await publicClient.getBalance({ address: relentsLater })) === PAID, "the first recipient got it, and nobody else could have");

console.log("\n12. The real commands, across a lost machine");
const { state: claims, account: claimsAccount, harbor: claimsHarbor } = await newHome("claims");
copyFileSync(keyPath("deployer.key"), join(claims, "deployer.key"));
writeFileSync(join(dir, "gas.key.txt"), deployer, { mode: 0o600 });
done("the owner shields a note", claims, ["shield"]);
done("and a second", claims, ["shield"]);
done("the owner sets up the exit", claims, ["exit-setup", "--reserve", "0.05"]);
const rescueFile = join(dir, "rescue.json");
done("the owner signs a rescue in advance, before any claim exists", claims, ["nominee-setup", "--out", rescueFile]);
const claimSeed = readFileSync(join(claims, "note-seed.key"), "utf8").trim() as Hex;
const refusesAll = await deployRefuser(deployer);
stops("A recipient the trial shows will refuse, with nothing spent", claims, ["unshield", await place(RELENTS)], "refuses a plain payment");
stops("A recipient the trial cannot read, with nothing spent", claims, ["unshield", refusesAll], "could not check");
const refusalSaid = done("the holder sends anyway, with --no-check", claims, ["unshield", refusesAll, "--no-check"]);
check(refusalSaid.includes("refused the money") && !refusalSaid.includes(`ETH to ${refusesAll}`), "the command says the recipient refused, and does not say it was paid");
const secondNote = noteFromSeed(claimSeed, claimsAccount, chainId, 1);
done("and the second note the same way", claims, ["unshield", refusesAll, "--no-check"]);
const owedHere = done("this machine says what the chain says", claims, ["notes"]);
check((owedHere.match(/: owed/g) ?? []).length === 2, "both notes read as owed");
done("freeze", claims, ["freeze"]);
stops("A claim from the command, while frozen", claims, ["claim", fresh(), "--key-file", join(dir, "gas.key.txt")], "AccountFrozen");
done("unfreeze", claims, ["unfreeze"]);
const told = done("the pool says so", join(dir, "anyone"), ["pool", claimsAccount]);
check(told.includes("2 payments failed"), "the meter says two payments are still owed");
const newMachine = join(dir, "claims-machine");
mkdirSync(newMachine);
const claimPaper = join(dir, "claims-paper.txt");
writeFileSync(claimPaper, claimSeed);
const foundOwed = done("the machine is gone, and the seed finds the claims", newMachine, ["notes-restore", "--seed-file", claimPaper, "--account", claimsAccount]);
check(foundOwed.includes("2 notes found in 2 deposits: 2 owed"), line(foundOwed, /\d+ notes found.*/));
const paidByClaim = fresh();
done("a claim from the new machine, with the real command", newMachine, ["claim", paidByClaim, "--account", claimsAccount, "--key-file", join(dir, "gas.key.txt")]);
check((await publicClient.getBalance({ address: paidByClaim })) === PAID, `the recipient holds ${formatEther(PAID)} ETH`);
stops("A claim with no sender for its gas", newMachine, ["claim", fresh(), "--account", claimsAccount], "--key-file <file> is required");

console.log("\n13. A rescue signed before any of this still lands, with a claim outstanding");
const rescue = parseRescue(readFileSync(rescueFile, "utf8"));
const health = await checkRescue(rescue);
check(health.state === "ready", `the rescue checks out against the node: ${health.state}`);
const stillOwed = await held(claimsAccount);
check(stillOwed === PAID, `${formatEther(stillOwed)} ETH is still owed`);
const landed = await sendRescue(rescue, { log: (text) => console.log(`    ${text}`) });
steps.push({ step: "the rescue, with a claim outstanding", hash: landed.hash });
check(framesSucceeded(landed.receipt), `the rescue landed: ${landed.hash}`);
const atHarbor = await publicClient.getBalance({ address: claimsHarbor });
check(atHarbor >= stillOwed, `the harbor holds ${formatEther(atHarbor)} ETH, with the claim's money in it`);
const ended = await proofOf(claimsAccount, secondNote, 1, fresh());
await waitForSuccess(await walletFor(deployer).sendTransaction({ to: claimsAccount, value: parseEther("0.2"), gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "new money arriving");
await claimDies("A claim after the rescue, while frozen", claimsAccount, "AccountFrozen", ended);
done("the master key unfreezes", claims, ["unfreeze"]);
await claimDies("A claim against money that arrived after the rescue", claimsAccount, "PoolClosed", ended);
const after13 = done("the seed says where the money went", newMachine, ["notes-restore", "--account", claimsAccount]);
check(after13.includes("swept to the harbor") && !after13.includes(": owed"), line(after13, /\d+ notes found.*/));

console.log("\n14. The worst a recipient can do to the frame, at the deepest walk of the root ring");
const worst = await thiefAccount("worst", deployments().v2!.factory, parseEther("0.5"));
const victims: { note: Note; leaf: number }[] = [];
for (let i = 0; i < 4; i++) victims.push(await depositNote(`note ${i} for a hostile recipient`, worst));
// `_isKnownRoot` walks slots in order, so the dearest root is the one in slot 31: the root of the 32nd deposit.
const wallet = walletFor(deployer);
let nonce = await publicClient.getTransactionCount({ address: privateKeyToAccount(deployer).address });
const pending: Hex[] = [];
for (let i = victims.length; i < 32; i++) {
  pending.push(await wallet.writeContract({ address: worst.address, abi: accountV2Abi as never, functionName: "shield", args: [await noteCommitment(noteFromSeed(generatePrivateKey(), worst.address, chainId, i))], value: DENOM, gas: 8_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", nonce: nonce++, chain: undefined } as never));
}
for (const hash of pending) await waitForSuccess(hash, "a deposit");
check((await poolLeaves(worst.address)).length === 32, "32 deposits, so the newest root sits in the ring's last slot");
const hostile: { name: string; to: Address }[] = [
  { name: "a recipient that burns all its gas", to: await deployRefuser(deployer) },
  { name: "a recipient that reverts with 450,000 bytes", to: await place(REVERT_BOMB) },
  { name: "a recipient that eats the frame's state gas", to: await place(STATE_EATER) },
];
const frames: { recipient: string; senderGas: number; executionLimit: number }[] = [];
for (const [i, { name, to }] of hostile.entries()) {
  const victim = victims[i]!;
  const result = await mined(name, sendNote(worst.address, await proofOf(worst.address, victim.note, victim.leaf, to)));
  check((await stateOf(worst.address, victim.note)) === 2n, `${name}: the note is spent and owed, in a frame that succeeded`);
  frames.push({ recipient: name, senderGas: Number(BigInt(result.receipt.frameReceipts[1]!.gasUsed)), executionLimit: 500_000 });
}
const lastClaim = await proofOf(worst.address, victims[0]!.note, victims[0]!.leaf, fresh());
await claimLands("a claim to a fresh address", worst.address, lastClaim);
const held32 = await held(worst.address);
check(held32 === DENOM * 29n + PAID * 2n, `what is held adds up: 29 notes and two claims, ${formatEther(held32)} ETH`);

console.log("\n15. Whether the 24,576-byte limit on contract size holds on this fork");
const sizes: { bytes: number; deployed: boolean; codeBytes: number; gas: number }[] = [];
for (const bytes of [24_576, 24_577, 30_000]) {
  // PUSH2 length, PUSH0, RETURN: a contract of that many zero bytes.
  const hash = await walletFor(deployer).sendTransaction({ data: concat(["0x61", numberToHex(bytes, { size: 2 }), "0x5ff3"]), gas: 55_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1000 });
  const code = receipt.contractAddress ? await publicClient.getCode({ address: receipt.contractAddress }) : undefined;
  sizes.push({ bytes, deployed: receipt.status === "success", codeBytes: code ? size(code) : 0, gas: Number(receipt.gasUsed) });
  console.log(`  ${bytes} bytes: ${receipt.status}, ${code ? size(code) : 0} bytes of code on chain`);
}

const record = {
  ranAt: new Date().toISOString(),
  stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
  chainId,
  genesis: deployments().genesis,
  implementation: deployments().v2!.implementation,
  account,
  denomination: DENOM.toString(),
  v2RuntimeBytes: size((await publicClient.getCode({ address: deployments().v2!.implementation }))!),
  contractSizes: sizes,
  failures: tally.failures,
  transactions: steps,
  meter: readings,
  claims: claimed,
  hostileFrames: frames,
  mined: evidence,
  refusals,
};
writeFileSync(new URL("../../../docs/evidence/pool-latest.json", import.meta.url), JSON.stringify(record, null, 1) + "\n");
rmSync(dir, { recursive: true, force: true });
console.log(`\n${steps.filter((s) => s.hash).length + evidence.length + claimed.length} mined, ${refusals.length} refused, ${tally.failures} failures, ${Math.round((Date.now() - started) / 1000)}s`);
await stopProver();
process.exit(tally.failures ? 1 : 0);
