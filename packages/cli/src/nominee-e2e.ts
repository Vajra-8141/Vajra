/**
 * The nominee, end to end, on the mirror: a rescue the hash key signed in advance, held by a real process with no key, and everything a
 * thief or the holder might try. Each attack is really sent, and has to die with the name shown. Exits non-zero if anything differs from
 * the claim.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, bytesToHex, concat, decodeErrorResult, encodeFunctionData, formatEther, keccak256, parseAbi, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_FEES,
  DEVNET,
  ETH,
  type FrameTx,
  LEGACY_GAS_PRICE,
  RescueInvalid,
  RpcError,
  accountState,
  accountV2Abi,
  checkRescue,
  createExit,
  dailyTx,
  deployments,
  exitAbi,
  framesSucceeded,
  genesisHash,
  isLocalStack,
  ops,
  opsV2,
  parseRescue,
  profile,
  publicClient,
  readAccount,
  receiptOf,
  recoveryGate,
  recoveryTicket,
  recoveryTx,
  releaseCalls,
  rescueDue,
  rescueFile,
  sendAlt,
  sendCanonical,
  signDaily,
  signDailyTx,
  signExitTx,
  signRescue,
  simulateFrames,
  sleep,
  submit,
  txHash,
  waitForSuccess,
  walletFor,
  withMasterSignature,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { proveRecovery, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";
import { check, evidence, master, mined, newAccount, newSigner, refused, refusals, reverts, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this runs on the local mirror only, with VAJRA_STACK=local");

const started = Date.now();
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const v2 = deployments().v2!;
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const work = mkdtempSync(join(tmpdir(), "vajra-nominee-"));

/** An owner, as `vajra exit-setup` and `vajra nominee-setup` leave one: an account, an exit with its reserve, and a rescue in a file. */
async function ownerOf(name: string, o: { fund?: bigint; tokens?: Address[] } = {}) {
  const signer = newSigner();
  const exitTree = newSigner();
  const dailyKey = generatePrivateKey();
  const daily = privateKeyToAccount(dailyKey).address;
  const harbor = fresh();
  const harborSalt = keccak256(toHex(name));
  const account = await newAccount(deployer, signer, daily, harbor, harborSalt, o.fund ?? parseEther("2"));
  const { epochSalt } = await accountState(account);
  const exit = await createExit(deployer, v2.exitFactory!, account, exitTree.root, epochSalt, parseEther("0.05"));
  await mined(`${name}: the master key names the exit`, master(signer, account, epochSalt, [opsV2.setExit(exit)]));
  const extra = o.tokens ?? [];
  const { tx } = signRescue({ signer: exitTree, exit, account, epochSalt, harbor, harborSalt, tokens: extra.length, extra, fees: { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: DEFAULT_FEES.maxPriorityFeePerGas } });
  const text = rescueFile({ tx, genesis: await genesisHash(), marginSeconds: 15 });
  const path = join(work, `${name.replaceAll(" ", "-")}.json`);
  writeFileSync(path, text);
  return { name, signer, exitTree, dailyKey, daily, harbor, harborSalt, account, epochSalt, exit, tx, path, rescue: parseRescue(text) };
}
type Owner = Awaited<ReturnType<typeof ownerOf>>;

/** The holder's real process. It gets a folder with nothing in it, and it must leave that folder with nothing in it: it holds no key. */
function holder(o: Owner) {
  const dir = mkdtempSync(join(work, "holder-"));
  const lines: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [new URL("./main.ts", import.meta.url).pathname, "nominee-watch", "--rescue", o.path, "--interval", "1"], {
    env: { ...process.env, VAJRA_STATE_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      lines.push(line);
      console.log(`    holder: ${line.slice(0, 170)}`);
    }
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
  process.on("exit", () => child.kill());
  return { child, lines, done, dir, said: (pattern: RegExp) => lines.some((line) => pattern.test(line)) };
}
type Holder = ReturnType<typeof holder>;

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(500);
  }
  check(false, `timed out: ${what}`);
  return false;
}

const nextBlockTime = async () => Number((await publicClient.getBlock()).timestamp);
const item = (o: Owner, id: bigint) => publicClient.readContract({ address: o.account, abi: accountV2Abi as never, functionName: "queuedItem", args: [id] } as never) as Promise<{ state: number; executeAfter: bigint }>;
const steal = (o: Owner, to: Address, amount = parseEther("0.6")) => signDaily({ key: o.dailyKey, dailyKey: o.daily, account: o.account, calls: [ops.spend(ETH, to, amount)] });

/** The attack has to die at admission, with this name. */
async function refusedByExit(attack: string, tx: FrameTx, want: string) {
  try {
    const hash = await sendAlt(tx);
    check(false, `${attack}: ADMITTED ${hash}`);
    refusals.push({ attack, refusal: "ADMITTED" });
  } catch (error) {
    const message = error instanceof RpcError ? error.message : String(error);
    const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined;
    let name = message;
    if (data) {
      try {
        name = decodeErrorResult({ abi: exitAbi, data }).errorName;
      } catch {}
    }
    check(name === want, `${attack}: ${name === want ? name : `${message.slice(0, 220)} (wanted ${want})`}`);
    refusals.push({ attack, refusal: name.slice(0, 200) });
  }
}

function refusedByTheTool(attack: string, text: string) {
  try {
    parseRescue(text);
    check(false, `${attack}: the holder's tool took it`);
    refusals.push({ attack, refusal: "ACCEPTED" });
  } catch (error) {
    check(error instanceof RescueInvalid, `${attack}: ${(error as Error).message.slice(0, 110)}`);
    refusals.push({ attack, refusal: (error as Error).message.slice(0, 200) });
  }
}

/** It reached the end and its folder is empty, so nothing was kept and nothing could have been loaded. */
async function holderFinished(h: Holder, what: string) {
  const code = await Promise.race([h.done, sleep(60_000).then(() => "still running")]);
  check(code === 0, `${what}: the holder's process stopped by itself, code ${code}`);
  check(readdirSync(h.dir).length === 0, `${what}: it wrote nothing, and had no key to read`);
}

// --------------------------------------------------------------------------------------------- the file

console.log("\n1. The owner signs a rescue, and the holder's tool reads it from the signed bytes");
const first = await ownerOf("answered then silent");
check(first.rescue.account === first.account && first.rescue.exit === first.exit && first.rescue.harbor.toLowerCase() === first.harbor.toLowerCase(), "account, exit and harbor all come out of the signature's own bytes");
const firstCheck = await checkRescue(first.rescue);
check(firstCheck.state === "ready", `the node says it would work now: ${firstCheck.state}`);
const sim = await simulateFrames(first.tx);
check(BigInt(sim.maxCost) === first.rescue.maxCost, `the cost the tool works out is the node's own: ${formatEther(first.rescue.maxCost)} ETH`);
const rescueGas = firstCheck.state === "ready" ? { verify: firstCheck.verifyGas, wholeTx: firstCheck.totalGas, maxCostEth: formatEther(firstCheck.maxCost) } : null;
check(sim.canonicalMempoolValid === true, `the canonical mempool would take it: ${sim.canonicalMempoolViolation ?? "valid"}`);

console.log("\n2. What the holder can do with the file, or anyone who steals it");
const { tx } = first;
const body = tx.frames[1]!;
const edited = (data: Hex): FrameTx => ({ ...tx, frames: [tx.frames[0]!, { ...body, data }] });
await refusedByExit("The holder points the escape at their own address", edited(ops.escape(fresh(), first.harborSalt).data), "BadExitSignature");
await refusedByExit("The holder changes the salt", edited(ops.escape(first.harbor, keccak256(toHex("guess"))).data), "BadExitSignature");
await refusedByExit("The holder raises the fee, to burn the reserve", { ...tx, fees: { ...tx.fees, maxFeePerGas: tx.fees.maxFeePerGas * 2n } }, "BadExitSignature");
await refusedByExit("The holder cuts the SENDER frame's gas, so that it dies and spends the nonce key", { ...tx, frames: [tx.frames[0]!, { ...body, limits: { ...body.limits, execution: 1000n } }] }, "BadExitSignature");
const payHolder = lib.frame(profile, "SENDER", { target: fresh(), execution: 400_000n, state: 400_000n, value: parseEther("0.01"), data: "0x" });
await refusedByExit("The holder adds a frame paying themselves from the reserve", { ...tx, frames: [...tx.frames, payHolder] }, "FrameNotAllowed");
await refusedByExit("The holder sends it on another nonce key", { ...tx, nonceKeys: [BigInt(keccak256(toHex("another key")))] }, "NonceKeyNotBoundToLeaf");

const realButNotARescue = signExitTx({ signer: first.exitTree, exit: first.exit, account: first.account, epochSalt: first.epochSalt, calls: [ops.freeze()] }).tx;
refusedByTheTool("A file holding a real signature on something other than an escape", rescueFile({ tx: realButNotARescue, genesis: first.rescue.genesis, marginSeconds: 15 }));
const stolenFrom = bytesToHex(new TextEncoder().encode("{}"));
refusedByTheTool("A file that is not a rescue at all", stolenFrom);

console.log("\n3. What a thief with the daily key can do about it");
const asDaily = (calls: Parameters<typeof signDaily>[0]["calls"]) => signDaily({ key: first.dailyKey, dailyKey: first.daily, account: first.account, calls });
await refused("Daily key turns the exit off, to orphan the rescue", await asDaily([opsV2.setExit("0x0000000000000000000000000000000000000000")]), "EscapeKeyOutranks");
await refused("Daily key names another exit", await asDaily([opsV2.setExit(fresh())]), "EscapeKeyOutranks");
await refused("Daily key moves the harbor, so that the rescue fails", await asDaily([ops.setHarbor(keccak256(toHex("thief harbor")))]), "HarborImmutable");
const replaceTree = encodeFunctionData({ abi: exitAbi, functionName: "setRoot", args: [keccak256(toHex("thief tree"))] });
await refused("Daily key replaces the exit's tree, so that the rescue dies", await asDaily([{ data: replaceTree, target: first.exit, execution: 60_000n, state: 100_000n }]), "FrameNotAllowed");
const fromExit = await signDailyTx({ ...dailyTx({ account: first.account, dailyKey: first.daily, nonce: 0n, calls: [ops.spend(ETH, first.daily, 1n)] }), sender: first.exit, nonceKeys: tx.nonceKeys }, first.dailyKey);
await refusedByExit("Daily key spends the rescue's nonce key, from the exit's address", fromExit, "validation frame 0: reverted");
check((await checkRescue(first.rescue)).state === "ready", "after all that, the rescue would still work");

// ------------------------------------------------------------------------------------------- the switch

console.log("\n4. The owner answers, and the switch stays quiet");
let watching = holder(first);
await until("the holder to say it is ready", () => watching.said(/the rescue is ready/));
const cancelMe = fresh();
const payMe = fresh();
await mined("the thief queues a payment", await steal(first, cancelMe));
await mined("a second payment queues, and this one really is the owner's", await steal(first, payMe, parseEther("0.7")));
const [cancelItem, payItem] = (await readAccount(first.account)).items;
await mined("Not me: the owner cancels the first", master(first.signer, first.account, first.epochSalt, [ops.veto(cancelItem!.id)]));
await mined("Pay, it's me: the owner releases the second", master(first.signer, first.account, first.epochSalt, releaseCalls(payItem!)));
await until("both items to pass the time they would have left", async () => (await nextBlockTime()) > Number(payItem!.executeAfter) + 2);
check(!watching.said(/Sending the rescue/), "both were answered, so past the time they would have left, the holder has sent nothing");
check((await publicClient.getBalance({ address: first.harbor })) === 0n, "the harbor is still empty");
check(!(await accountState(first.account)).frozen, "the account is not frozen");
check(watching.child.exitCode === null, "and the holder is still watching");

console.log("\n5. Nobody answers, with a thief keeping a transaction pending the whole time");
const thiefPayee = fresh();
await mined("the thief queues 0.6 ETH", await steal(first, thiefPayee));
const theft = (await rescueDue(first.rescue)).waiting[0]!;
let pinning = true;
let pins = 0;
const pinLoop = (async () => {
  const pinned = fresh();
  while (pinning) {
    const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
    const nonce = BigInt(await publicClient.getTransactionCount({ address: first.account }));
    const pin = await signDailyTx(dailyTx({ account: first.account, dailyKey: first.daily, nonce, calls: [ops.spend(ETH, pinned, 1n)], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }), first.dailyKey);
    await sendCanonical(pin).then(() => pins++, () => {});
    await sleep(1000);
  }
})();
await until("the rescue to land", async () => (await receiptOf(first.rescue.hash)) !== null);
pinning = false;
await pinLoop;
const rescued = await receiptOf(first.rescue.hash);
if (!rescued) throw new Error("the rescue never landed, so nothing after this means anything");
const landedAt = Number((await publicClient.getBlock({ blockNumber: BigInt(rescued.blockNumber) })).timestamp);
const secondsLeft = Number(theft.executeAfter) - landedAt;
evidence.push({ step: "The rescue, sent by a process with no key, because nobody answered", hash: first.rescue.hash, block: Number(BigInt(rescued.blockNumber)), verifyGas: Number(BigInt(rescued.frameReceipts[0]!.gasUsed)), totalGas: Number(BigInt(rescued.gasUsed)), attempts: 1 });
check(framesSucceeded(rescued), `the rescue mined: ${first.rescue.hash}, VERIFY ${Number(BigInt(rescued.frameReceipts[0]!.gasUsed))} gas, ${Number(BigInt(rescued.gasUsed))} in all`);
check(secondsLeft > 0, `it landed with ${secondsLeft} seconds to spare, past ${pins} pending thief transactions`);
await holderFinished(watching, "after the rescue");
check((await publicClient.getBalance({ address: first.harbor })) > parseEther("1.2"), `the harbor holds ${formatEther(await publicClient.getBalance({ address: first.harbor }))} ETH`);
check((await accountState(first.account)).frozen, "the account is frozen");
await until("the theft's time to arrive", async () => (await nextBlockTime()) > Number(theft.executeAfter) + 1);
await refused("The thief collects, with the daily key, once the time is up", await signDaily({ key: first.dailyKey, dailyKey: first.daily, account: first.account, calls: [ops.executeQueued(theft.id)] }), "AccountFrozen");
await reverts("Anyone collects for the thief, once the time is up", "AccountFrozen", { account: privateKeyToAccount(deployer).address, address: first.account, functionName: "executeQueued", args: [theft.id] });
check((await publicClient.getBalance({ address: thiefPayee })) === 0n, "the thief has nothing");
const replay = await sendAlt(first.tx).then(() => "ADMITTED", (error: Error) => error.message);
check(/nonce|LeafAlreadySpent/i.test(replay), `the same bytes again: ${replay.slice(0, 90)}`);
refusals.push({ attack: "The same bytes again, after they landed", refusal: replay.slice(0, 200) });
check((await checkRescue(first.rescue)).state === "sent", "the tool says it has been sent");

console.log("\n6. A theft hidden behind a dozen more, on an account short of ETH, holding tokens");
const TOKENS = 25_000_000n;
const second = await ownerOf("hidden and short of ETH", { fund: parseEther("0.032"), tokens: [DEVNET.usdc] });
await waitForSuccess(await walletFor(deployer).writeContract({ address: DEVNET.usdc, abi: erc20, functionName: "transfer", args: [second.account, TOKENS], gas: 300_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined }), "funding the tokens");
watching = holder(second);
await until("the holder to say it is ready", () => watching.said(/the rescue is ready/));
const hiddenPayee = fresh();
const queued = (to: Address, amount: bigint) => ({ ...ops.spend(ETH, to, amount), execution: 200_000n, state: 700_000n });
const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
await mined(
  "the thief queues one, and a dozen more behind it, in one transaction",
  await signDailyTx(
    dailyTx({
      account: second.account,
      dailyKey: second.daily,
      nonce: BigInt(await publicClient.getTransactionCount({ address: second.account })),
      verifyGas: 400_000n,
      calls: [queued(hiddenPayee, parseEther("0.6")), ...Array.from({ length: 12 }, (_, i) => queued(fresh(), parseEther("0.6") + BigInt(i)))],
      fees: { maxFeePerGas: base * 4n + 100n, maxPriorityFeePerGas: 1n },
    }),
    second.dailyKey,
  ),
);
check((await readAccount(second.account)).items.some((one) => one.id === 0n), "the first of them is still in what a reader sees, with twelve newer ones behind it");
await until("the rescue to land", async () => (await receiptOf(second.rescue.hash)) !== null);
const secondReceipt = (await receiptOf(second.rescue.hash))!;
evidence.push({ step: "The rescue, with a theft hidden behind a dozen more, on an account short of ETH", hash: second.rescue.hash, block: Number(BigInt(secondReceipt.blockNumber)), verifyGas: Number(BigInt(secondReceipt.frameReceipts[0]!.gasUsed)), totalGas: Number(BigInt(secondReceipt.gasUsed)), attempts: 1 });
check(framesSucceeded(secondReceipt), `the rescue mined: ${second.rescue.hash}`);
await holderFinished(watching, "after the hidden theft");
const tokensLanded = await publicClient.readContract({ address: DEVNET.usdc, abi: erc20, functionName: "balanceOf", args: [second.harbor] });
check(tokensLanded === TOKENS, `the harbor holds all ${tokensLanded} tokens`);
check((await publicClient.getBalance({ address: second.harbor })) > 0n, `and the ${formatEther(await publicClient.getBalance({ address: second.harbor }))} ETH left, none of it spent on the rescue: the exit paid`);
check((await publicClient.getBalance({ address: hiddenPayee })) === 0n, "the thief has nothing");

console.log("\n7. A stolen recovery paper, on a frozen account");
const third = await ownerOf("stolen paper");
const paper = randomFieldElement();
const ticket = recoveryTicket(paper);
await mined("the owner sets a paper", master(third.signer, third.account, third.epochSalt, [opsV2.setRecovery(await recoveryCommitment(paper), 60n, recoveryGate(ticket))]));
await mined("the thief queues a payment", await steal(third, fresh()));
const frozenItem = (await readAccount(third.account)).items[0]!;
await mined("the owner freezes, and goes offline", master(third.signer, third.account, third.epochSalt, [ops.freeze()]));
watching = holder(third);
await until("the holder to say it is ready", () => watching.said(/the rescue is ready/));
await until("the frozen payment to pass the time it would have left", async () => (await nextBlockTime()) > Number(frozenItem.executeAfter) + 2);
check(!watching.said(/Sending the rescue/), "a freeze stops that payment from leaving, so the holder has sent nothing");
const thiefRoot = newSigner().root;
const proved = await proveRecovery({ secret: paper, newRoot: thiefRoot, account: third.account, epochSalt: third.epochSalt, chainId: DEVNET.chainId });
await stopProver();
await mined("the thief uses the stolen paper", recoveryTx({ account: third.account, newRoot: thiefRoot, nullifier: proved.nullifier, proof: proved.proof, ticket }));
await until("the rescue to land", async () => (await receiptOf(third.rescue.hash)) !== null);
const thirdReceipt = (await receiptOf(third.rescue.hash))!;
evidence.push({ step: "The rescue, ahead of a stolen paper taking effect", hash: third.rescue.hash, block: Number(BigInt(thirdReceipt.blockNumber)), verifyGas: Number(BigInt(thirdReceipt.frameReceipts[0]!.gasUsed)), totalGas: Number(BigInt(thirdReceipt.gasUsed)), attempts: 1 });
check(framesSucceeded(thirdReceipt), `a recovery is not stopped by a freeze, so this one set the switch off: ${third.rescue.hash}`);
await holderFinished(watching, "ahead of the stolen paper");
check((await publicClient.getBalance({ address: third.harbor })) > parseEther("1.5"), "the money reached the harbor before the thief's key tree could");

console.log("\n8. A rescue that would fail is said to, and is not sent");
const fourth = await ownerOf("harbor moved");
const movedHarbor = keccak256(toHex("the owner's new harbor"));
await mined("the owner changes the harbor, and forgets the rescue", master(fourth.signer, fourth.account, fourth.epochSalt, [ops.setHarbor(movedHarbor)]));
const moved = await checkRescue(fourth.rescue);
check(moved.state === "broken" && /changed the harbor/.test(moved.reason), `the tool says so: ${moved.state === "broken" ? moved.reason : moved.state}`);
watching = holder(fourth);
await mined("the thief queues a payment", await steal(fourth, fresh()));
await until("the holder to say it would fail", () => watching.said(/WOULD FAIL/));
check((await receiptOf(fourth.rescue.hash)) === null, "it did not send it, so the leaf is not burned on a transaction it knows would fail");
watching.child.kill();
await watching.done;

console.log("\n9. The owner ends every rescue, with the master key");
const fifth = await ownerOf("revoked");
const nextTree = newSigner();
await mined("a new exit tree, master key", master(fifth.signer, fifth.account, fifth.epochSalt, [{ data: encodeFunctionData({ abi: exitAbi, functionName: "setRoot", args: [nextTree.root] }), target: fifth.exit, execution: 60_000n, state: 100_000n }]));
const revoked = await checkRescue(fifth.rescue);
check(revoked.state === "broken" && /key tree was replaced/.test(revoked.reason), `the tool says the old one is dead: ${revoked.state === "broken" ? revoked.reason.slice(0, 60) : revoked.state}`);
await refusedByExit("The old rescue, after the owner ended it", fifth.tx, "NonceKeyNotBoundToLeaf");
const again = signRescue({ signer: nextTree, exit: fifth.exit, account: fifth.account, epochSalt: fifth.epochSalt, harbor: fifth.harbor, harborSalt: fifth.harborSalt, tokens: 0 }).tx;
check((await checkRescue(parseRescue(rescueFile({ tx: again, genesis: fifth.rescue.genesis, marginSeconds: 15 })))).state === "ready", "a new one, from the new tree, works");

console.log("\n10. What the file cannot stop: a copy, padded");
const sixth = await ownerOf("padded");
const padded = withMasterSignature(sixth.tx, concat([sixth.tx.signatures[0]!.signature, bytesToHex(new Uint8Array(8192))]));
const before = await publicClient.getBalance({ address: sixth.exit });
const paddedLanding = await submit(padded, { log: (line) => console.log(`    ${line}`) });
const paddedCost = before - (await publicClient.getBalance({ address: sixth.exit }));
evidence.push({ step: "A copy of the rescue, padded by 8 KB, and it still rescues", hash: paddedLanding.hash, block: Number(BigInt(paddedLanding.receipt.blockNumber)), verifyGas: Number(BigInt(paddedLanding.receipt.frameReceipts[0]!.gasUsed)), totalGas: Number(BigInt(paddedLanding.receipt.gasUsed)), attempts: paddedLanding.attempts });
check(framesSucceeded(paddedLanding.receipt), `it mined, and the reserve paid ${formatEther(paddedCost)} ETH for it. This is the hole in FINDINGS section 15`);
check((await publicClient.getBalance({ address: sixth.harbor })) > parseEther("1.9"), "the money still went to the harbor, and nowhere else");
check((await checkRescue(sixth.rescue)).state === "sent", "the tool says it was sent, by a copy, whose hash is not the file's");

const result = {
  ranAt: new Date().toISOString(),
  stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
  chainId: DEVNET.chainId,
  genesis: deployments().genesis,
  holder: "a real process, `vajra nominee-watch`, started with an empty state folder, which it left empty",
  queueDelaySeconds: 60,
  marginSeconds: 15,
  rescueGas,
  secondsLeftWhenTheRescueLanded: secondsLeft,
  thiefTransactionsPendingMeanwhile: pins,
  account: first.account,
  exit: first.exit,
  failures: tally.failures,
  mined: evidence,
  refusals,
};
writeFileSync(new URL("../../../docs/evidence/nominee-latest.json", import.meta.url), JSON.stringify(result, null, 1) + "\n");
rmSync(work, { recursive: true, force: true });
console.log(`\n${evidence.length} mined, ${refusals.length} refused, ${tally.failures} failures, ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(tally.failures ? 1 : 0);
