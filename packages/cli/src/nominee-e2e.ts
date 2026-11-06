/**
 * The nominee, end to end, on the mirror: a rescue the hash key signed in advance, held by a real process with no key, and everything a
 * thief or the holder might try. Each attack is really sent, and has to die with the name shown. Exits non-zero if anything differs from
 * the claim.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
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
  MasterSigner,
  RescueInvalid,
  RpcError,
  WOTS_W16,
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
  memoryStore,
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
  rpc,
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
  wouldBurn,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { proveRecovery, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";
import { check, evidence, master, mined, newAccount, newSigner, preFixV2Factory, refused, refusals, reverts, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this runs on the local mirror only, with VAJRA_STACK=local");

const started = Date.now();
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const v2 = deployments().v2!;
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const work = mkdtempSync(join(tmpdir(), "vajra-nominee-"));

/** An owner, as `vajra exit-setup` and `vajra nominee-setup` leave one: an account, an exit with its reserve, and a rescue in a file. */
async function ownerOf(name: string, o: { fund?: bigint; tokens?: Address[]; reserve?: bigint; margin?: number; exitSeed?: Uint8Array; factory?: Address } = {}) {
  const signer = newSigner();
  const exitTree = o.exitSeed ? new MasterSigner(WOTS_W16, memoryStore(), () => o.exitSeed!) : newSigner();
  const dailyKey = generatePrivateKey();
  const daily = privateKeyToAccount(dailyKey).address;
  const harbor = fresh();
  const harborSalt = keccak256(toHex(name));
  const account = await newAccount(deployer, signer, daily, harbor, harborSalt, o.fund ?? parseEther("2"), o.factory);
  const { epochSalt } = await accountState(account);
  const exit = await createExit(deployer, v2.exitFactory!, account, exitTree.root, epochSalt, o.reserve ?? parseEther("0.05"));
  await mined(`${name}: the master key names the exit`, master(signer, account, epochSalt, [opsV2.setExit(exit)]));
  const extra = o.tokens ?? [];
  const { tx } = signRescue({ signer: exitTree, exit, account, epochSalt, harbor, harborSalt, tokens: extra.length, extra, fees: { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: DEFAULT_FEES.maxPriorityFeePerGas } });
  const text = rescueFile({ tx, genesis: await genesisHash(), marginSeconds: o.margin ?? 15 });
  const path = join(work, `${name.replaceAll(" ", "-")}.json`);
  writeFileSync(path, text);
  return { name, signer, exitTree, dailyKey, daily, harbor, harborSalt, account, epochSalt, exit, tx, path, rescue: parseRescue(text) };
}
type Owner = Awaited<ReturnType<typeof ownerOf>>;

/** The holder's real process. It gets a folder with nothing in it, and it must leave that folder with nothing in it: it holds no key. */
function holder(o: Owner, lane?: number) {
  const dir = mkdtempSync(join(work, "holder-"));
  const lines: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [new URL("./main.ts", import.meta.url).pathname, "nominee-watch", "--rescue", o.path, "--interval", "1"], {
    env: { ...process.env, VAJRA_STATE_DIR: dir, ...(lane === undefined ? {} : { VAJRA_LANE: String(lane) }) },
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

/**
 * The network between a holder and the chain, for a holder on a lane of its own. The chain behind it is the real one and the process is the
 * real one, and this decides what reaches them: a node that will not simulate, a node that dies, a head that stops moving, a sidecar that
 * is down or sits on what it is given. So it refuses, and replays an old block, and it answers for a sidecar that sits on a transaction.
 */
function network(lane: number, o: { mempool?: "up" | "down" | "sits"; simulate?: boolean } = {}) {
  const state = { alive: true, stuck: false };
  let oldHead: unknown = null;
  const bodyOf = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => resolve(text));
    });
  const relay = async (to: string, body: string, res: ServerResponse) => {
    const answer = await fetch(to, { method: "POST", headers: { "content-type": "application/json" }, body });
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(await answer.text());
  };
  const reply = (res: ServerResponse, id: number, body: object) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  };
  const servers = [
    createServer(async (req, res) => {
      const body = await bodyOf(req);
      const call = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      if (o.simulate === false && call.method === "ethrex_simulateFrameTransaction") return reply(res, call.id, { error: { code: -32601, message: "Method not found" } });
      if (!state.alive) {
        res.writeHead(503);
        res.end("no");
        return;
      }
      if (state.stuck && call.method === "eth_getBlockByNumber" && call.params?.[0] === "latest") {
        oldHead ??= await rpc(DEVNET.execution, "eth_getBlockByNumber", ["latest", false]);
        return reply(res, call.id, { result: oldHead });
      }
      await relay(DEVNET.execution, body, res);
    }).listen(18545 + lane * 100, "127.0.0.1"),
  ];
  if (o.mempool !== "down") {
    servers.push(
      createServer(async (req, res) => {
        const body = await bodyOf(req);
        if (o.mempool !== "sits") return relay(DEVNET.mempool, body, res);
        const call = JSON.parse(body) as { id: number; method: string };
        reply(res, call.id, { result: call.method === "skandha_frameTransactionStatus" ? { status: "Pending" } : `0x${"ab".repeat(32)}` });
      }).listen(14337 + lane * 100, "127.0.0.1"),
    );
  }
  return {
    state,
    close: () => {
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
    },
  };
}

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
/** Whether the node's own pool holds a transaction from this account right now. */
const hasPending = async (account: Address) => {
  const pool = await rpc<{ pending: Record<string, unknown> }>(DEVNET.execution, "txpool_content");
  return Object.keys(pool.pending).some((sender) => sender.toLowerCase() === account.toLowerCase());
};

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
refusedByTheTool("A file with a margin of nothing, which would fire when the thief can already collect", rescueFile({ tx, genesis: first.rescue.genesis, marginSeconds: 0 }));
const badMargin = spawnSync(process.execPath, [new URL("./main.ts", import.meta.url).pathname, "nominee-watch", "--rescue", first.path, "--margin", "1h"], { encoding: "utf8" });
check(badMargin.status !== 0 && /whole number of seconds/.test(badMargin.stderr + badMargin.stdout), "`--margin 1h` is refused, and does not watch in silence for ever");
refusals.push({ attack: "A holder asks for a margin of 1h, which is not a number", refusal: "--margin is a whole number of seconds" });

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

console.log("\n5. Nobody answers, with a thief sending a transaction every second");
const thiefPayee = fresh();
await mined("the thief queues 0.6 ETH", await steal(first, thiefPayee));
const theft = (await rescueDue(first.rescue)).waiting[0]!;
let pinning = true;
let pins = 0;
const pendingSeen: boolean[] = [];
const pinLoop = (async () => {
  const pinned = fresh();
  while (pinning) {
    const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
    const nonce = BigInt(await publicClient.getTransactionCount({ address: first.account }));
    const pin = await signDailyTx(dailyTx({ account: first.account, dailyKey: first.daily, nonce, calls: [ops.spend(ETH, pinned, 1n)], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }), first.dailyKey);
    await sendCanonical(pin).then(() => pins++, () => {});
    await sleep(1000);
    pendingSeen.push(await hasPending(first.account));
  }
})();
await until("the rescue to land", async () => (await receiptOf(first.rescue.hash)) !== null);
pinning = false;
await pinLoop;
check(pendingSeen.slice(-5).some(Boolean), `a thief's transaction really was in the node's pool as the rescue went: seen in ${pendingSeen.filter(Boolean).length} of ${pendingSeen.length} looks, and in ${pendingSeen.slice(-5).filter(Boolean).length} of the last 5`);
const rescued = await receiptOf(first.rescue.hash);
if (!rescued) throw new Error("the rescue never landed, so nothing after this means anything");
const landedAt = Number((await publicClient.getBlock({ blockNumber: BigInt(rescued.blockNumber) })).timestamp);
const secondsLeft = Number(theft.executeAfter) - landedAt;
evidence.push({ step: "The rescue, sent by a process with no key, because nobody answered", hash: first.rescue.hash, block: Number(BigInt(rescued.blockNumber)), verifyGas: Number(BigInt(rescued.frameReceipts[0]!.gasUsed)), totalGas: Number(BigInt(rescued.gasUsed)), attempts: 1 });
check(framesSucceeded(rescued), `the rescue mined: ${first.rescue.hash}, VERIFY ${Number(BigInt(rescued.frameReceipts[0]!.gasUsed))} gas, ${Number(BigInt(rescued.gasUsed))} in all`);
check(secondsLeft > 0, `it landed with ${secondsLeft} seconds to spare, with ${pins} thief transactions sent meanwhile`);
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

console.log("\n6. A theft hidden behind a dozen more, on an account holding tokens");
const TOKENS = 25_000_000n;
const second = await ownerOf("hidden", { fund: parseEther("0.7"), tokens: [DEVNET.usdc] });
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
const heldBefore = await publicClient.getBalance({ address: second.account });
check(heldBefore >= parseEther("0.6"), `the account can really pay the first of them: it holds ${formatEther(heldBefore)} ETH`);
const hiddenTheft = (await rescueDue(second.rescue)).waiting[0]!;
await until("the rescue to land", async () => (await receiptOf(second.rescue.hash)) !== null);
const secondReceipt = (await receiptOf(second.rescue.hash))!;
evidence.push({ step: "The rescue, with a theft hidden behind a dozen more", hash: second.rescue.hash, block: Number(BigInt(secondReceipt.blockNumber)), verifyGas: Number(BigInt(secondReceipt.frameReceipts[0]!.gasUsed)), totalGas: Number(BigInt(secondReceipt.gasUsed)), attempts: 1 });
check(framesSucceeded(secondReceipt), `the rescue mined: ${second.rescue.hash}`);
await holderFinished(watching, "after the hidden theft");
const tokensLanded = await publicClient.readContract({ address: DEVNET.usdc, abi: erc20, functionName: "balanceOf", args: [second.harbor] });
check(tokensLanded === TOKENS, `the harbor holds all ${tokensLanded} tokens`);
check((await publicClient.getBalance({ address: second.harbor })) === heldBefore, `and all ${formatEther(heldBefore)} ETH the account held, none of it spent on the rescue: the exit paid`);
await until("the hidden theft's time to arrive", async () => (await nextBlockTime()) > Number(hiddenTheft.executeAfter) + 1);
await reverts("Anyone collects the hidden theft, once the time is up", "AccountFrozen", { account: privateKeyToAccount(deployer).address, address: second.account, functionName: "executeQueued", args: [hiddenTheft.id] });
check((await publicClient.getBalance({ address: hiddenPayee })) === 0n, "the thief has nothing, from an account that could have paid");

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
const copied = await checkRescue(sixth.rescue);
check(copied.state === "sent" && copied.copy && copied.hash === paddedLanding.hash && copied.hash !== sixth.rescue.hash, `the tool says it was sent, by a copy, and names the copy from the chain's own log: ${copied.state === "sent" ? copied.hash : copied.state}`);

console.log("\n11. What goes wrong between the holder and the chain, each with a real theft and a real process");
const dark = await ownerOf("the node goes dark");
const sidecarDown = await ownerOf("the sidecar is down");
const sidecarSits = await ownerOf("the sidecar sits on it");
const stuckHead = await ownerOf("the head stops");
const short = await ownerOf("a short reserve", { reserve: parseEther("0.001") });
const shortCheck = await checkRescue(short.rescue);
check(shortCheck.state === "broken" && !wouldBurn(shortCheck), `a reserve that is short is said to be, and holds nothing back: ${shortCheck.state === "broken" ? shortCheck.reason.slice(0, 80) : shortCheck.state}`);

async function theNodeGoesDark() {
  const net = network(LANES + 1, { simulate: false });
  const h = holder(dark, LANES + 1);
  await until("the holder to say it cannot tell", () => h.said(/the rescue is unknown/));
  check(!h.said(/would fail|WOULD FAIL/i), "a node that will not simulate is unknown, and is not called broken");
  await mined("the node goes dark: the thief queues a payment", await steal(dark, fresh()));
  await until("the holder to see the item", () => h.said(/leaves in/));
  net.state.alive = false;
  await until("the rescue to land, with nothing reaching the holder's node", async () => (await receiptOf(dark.rescue.hash)) !== null);
  check(h.said(/state unknown/), "the holder's node is dead: no read and no send gets through it");
  check(h.said(/the last good read said it is time/) && h.said(/admitted by the alt mempool/), "and it sent on the last good read, through the sidecar");
  net.state.alive = true;
  await holderFinished(h, "after the node came back");
  check((await publicClient.getBalance({ address: dark.harbor })) > parseEther("1.2"), "the money reached the harbor");
  net.close();
}

/** Lanes for the proxies, well clear of any real mirror, and clear of a suite running on another lane. */
const LANES = 16 + Number(process.env.VAJRA_LANE ?? 0) * 4;
const spare: { run: string; secondsToSpare: number }[] = [];

/** A node stuck at one block. It goes on showing the item with the same time left, and the theft on the real chain does not wait. */
async function theHeadStops() {
  const net = network(LANES);
  const h = holder(stuckHead, LANES);
  await until("the holder to say it is ready", () => h.said(/the rescue is ready/));
  await mined("the head stops: the thief queues a payment", await steal(stuckHead, fresh()));
  const theft = (await rescueDue(stuckHead.rescue)).waiting[0]!;
  await until("the holder to see the item", () => h.said(/leaves in/));
  net.state.stuck = true;
  await until("the rescue to land, with the holder's head stopped", async () => (await receiptOf(stuckHead.rescue.hash)) !== null);
  const receipt = (await receiptOf(stuckHead.rescue.hash))!;
  const landedAt = Number((await publicClient.getBlock({ blockNumber: BigInt(receipt.blockNumber) })).timestamp);
  spare.push({ run: "the head stops", secondsToSpare: Number(theft.executeAfter) - landedAt });
  check(framesSucceeded(receipt) && landedAt < Number(theft.executeAfter), `the head stopped, and the rescue still went, with ${Number(theft.executeAfter) - landedAt} seconds to spare`);
  await holderFinished(h, "the head stops");
  net.close();
}

async function theSidecarIsDown(who: Owner, lane: number, mode: "down" | "sits") {
  const net = network(lane, { mempool: mode });
  const h = holder(who, lane);
  await until("the holder to say it is ready", () => h.said(/the rescue is ready/));
  await mined(`${who.name}: the thief queues a payment`, await steal(who, fresh()));
  const theft = (await rescueDue(who.rescue)).waiting[0]!;
  await until(`${who.name}: the rescue to land`, async () => (await receiptOf(who.rescue.hash)) !== null);
  check(h.said(/the alt mempool did not carry it/), `${who.name}: the alt mempool could not carry it, and the holder said so`);
  const receipt = (await receiptOf(who.rescue.hash))!;
  const landedAt = Number((await publicClient.getBlock({ blockNumber: BigInt(receipt.blockNumber) })).timestamp);
  spare.push({ run: who.name, secondsToSpare: Number(theft.executeAfter) - landedAt });
  check(framesSucceeded(receipt) && landedAt < Number(theft.executeAfter), `${who.name}: the canonical mempool carried it, with ${Number(theft.executeAfter) - landedAt} seconds to spare`);
  await holderFinished(h, who.name);
  net.close();
}

async function theReserveIsShort() {
  const h = holder(short);
  await until("the holder to say it is broken", () => h.said(/the rescue is broken/));
  await mined("a short reserve: the thief queues a payment", await steal(short, fresh()));
  await until("the holder to try, and fail", () => h.said(/did not go through/));
  check((await receiptOf(short.rescue.hash)) === null, "both mempools turned it away, so it mined nothing and burned nothing");
  await waitForSuccess(await walletFor(deployer).sendTransaction({ to: short.exit, value: parseEther("0.05"), gas: 100_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined }), "topping up the reserve");
  await until("the rescue to land, once anyone topped the reserve up", async () => (await receiptOf(short.rescue.hash)) !== null);
  check(framesSucceeded((await receiptOf(short.rescue.hash))!), "topped up by someone with no key, and the rescue mined");
  await holderFinished(h, "a short reserve");
}

await Promise.all([theNodeGoesDark(), theHeadStops(), theSidecarIsDown(sidecarDown, LANES + 2, "down"), theSidecarIsDown(sidecarSits, LANES + 3, "sits"), theReserveIsShort()]);

console.log("\n12. A signer restored from an old backup spends the rescue's own leaf");
const seed = new Uint8Array(randomBytes(32));
const reused = await ownerOf("reused leaf", { exitSeed: seed });
const restored = new MasterSigner(WOTS_W16, memoryStore(), () => seed);
watching = holder(reused);
await until("the holder to say it is ready", () => watching.said(/the rescue is ready/));
await mined("the thief queues a payment", await steal(reused, fresh()));
await mined("the restored signer cancels it, on the leaf the rescue already used", signExitTx({ signer: restored, exit: reused.exit, account: reused.account, epochSalt: reused.epochSalt, calls: [ops.veto(0n)] }).tx);
await until("the holder to notice", () => watching.said(/spent by another transaction/));
const spent = await checkRescue(reused.rescue);
check(spent.state === "broken", `a spent key with nothing at the harbor is not called sent: ${spent.state === "broken" ? spent.reason.slice(0, 80) : spent.state}`);
check(!watching.said(/already sent|rescued:/), "the holder does not say it was rescued");
check(watching.child.exitCode === null, "and it is still watching");
check((await publicClient.getBalance({ address: reused.harbor })) === 0n, "the harbor is empty, as the tool says");
watching.child.kill();
await watching.done;

console.log("\n13. The owner's real commands, a lost seed, and the end of every rescue");
const state = mkdtempSync(join(work, "owner-"));
copyFileSync(keyPath("deployer.key"), join(state, "deployer.key"));
const cli = (...args: string[]) => {
  const run = spawnSync(process.execPath, [new URL("./main.ts", import.meta.url).pathname, ...args], { env: { ...process.env, VAJRA_STATE_DIR: state }, encoding: "utf8" });
  return { ok: run.status === 0, said: run.stdout + run.stderr };
};
const realHarbor = fresh();
check(cli("create", "--harbor", realHarbor, "--delay", "60", "--cooling", "0", "--limit", "0.1", "--allowance", "0.1", "--fund", "2").ok, "`vajra create`");
check(cli("exit-setup", "--reserve", "0.001").ok, "`vajra exit-setup`, with a reserve too small for a rescue");
const tooSmall = cli("nominee-setup", "--out", join(state, "small.json"));
check(!tooSmall.ok && /Do not hand this over/.test(tooSmall.said) && !/Give that file/.test(tooSmall.said), "`vajra nominee-setup` says not to hand it over, and does not say to");
const treePath = join(state, "signer.exit.json");
renameSync(treePath, join(state, "put-away.json"));
const noTree = cli("nominee-setup", "--out", join(state, "no-tree.json"));
check(!noTree.ok && /does not hold the exit's key/.test(noTree.said), "with the seed lost, it refuses, and does not sign with a new one");
check(!existsSync(treePath) && !existsSync(join(state, "no-tree.json")), "and it made no new tree and no file");
refusals.push({ attack: "The owner signs a rescue after losing the exit's seed", refusal: "does not hold the exit's key" });
renameSync(join(state, "put-away.json"), treePath);
const topUp = JSON.parse(readFileSync(join(state, "exit.json"), "utf8")) as { exit: Address };
await waitForSuccess(await walletFor(deployer).sendTransaction({ to: topUp.exit, value: parseEther("0.05"), gas: 100_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined }), "topping up the reserve");
const realFile = join(state, "for-the-nominee.json");
const setUp = cli("nominee-setup", "--out", realFile);
check(setUp.ok && /Give that file/.test(setUp.said), "`vajra nominee-setup`, with a reserve that covers it");
check(cli("nominee-check", realFile).ok, "`vajra nominee-check` says it would work");
const revoke = cli("nominee-revoke");
check(revoke.ok, "`vajra nominee-revoke`, signed by the master key");
check(readdirSync(state).some((name) => name.startsWith("signer.exit.before-")) && existsSync(treePath) && !existsSync(join(state, "signer.exit.next.json")), "the old tree is kept, the new one is in place, and nothing is left half done");
const dead = cli("nominee-check", realFile);
check(!dead.ok && /key tree was replaced/.test(dead.said), "the old rescue is dead, and the tool says why");
const fresher = join(state, "rescue-2.json");
check(cli("nominee-setup", "--out", fresher).ok && cli("nominee-check", fresher).ok, "a new one, signed by the new tree, works");
check(cli("thief", "0.6").ok && cli("freeze").ok, "a theft waits, and the owner freezes");
const thaw = cli("unfreeze");
check(!thaw.ok && /still waiting/.test(thaw.said), "`vajra unfreeze` refuses before it signs, because a freeze never ended the theft");
const held = JSON.parse(readFileSync(join(state, "wallet.json"), "utf8")) as { account: Address };
check((await accountState(held.account)).frozen, "so the account is still frozen");
refusals.push({ attack: "The owner unfreezes with a theft still waiting", refusal: "refused before signing: still waiting" });
check(cli("veto", "0").ok && cli("unfreeze").ok && !(await accountState(held.account)).frozen, "cancelled first, it unfreezes");

console.log("\n14. A token that spends the frame's state gas, swept before the harbor is paid and after");
/**
 * Says it holds a balance, and writes five new slots on `transfer`, so it succeeds and keeps what it spent: 489,600 of a frame's 700,000 state gas,
 * which leaves too little for a fresh harbor and the pool closing. Eleven bytes of init code, then 43 of runtime, told apart by calldata size.
 */
const STATE_SPENDING_TOKEN = "0x602b80600b6000396000f336602414602057600160015560016002556001600355600160045560016005555b600160005260206000f3";
/** The same, writing one slot, so that what halts the frame above is shown to be the state gas and nothing else about a token. */
const ONE_SLOT_TOKEN = "0x601780600b6000396000f336602414600c5760016001555b600160005260206000f3";
const placeToken = async (data: string = STATE_SPENDING_TOKEN) => {
  const hash = await walletFor(deployer).sendTransaction({ data: data as Hex, gas: 1_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  return (await waitForSuccess(hash, "placing the token")).contractAddress!;
};
const swept = async (who: Owner) => {
  const landing = await submit(who.tx, { log: (line) => console.log(`    ${line}`) });
  const harborHolds = await publicClient.getBalance({ address: who.harbor });
  const frame = landing.receipt.frameReceipts[1]!;
  evidence.push({ step: `A token that spends the frame's state gas: ${who.name}`, hash: landing.hash, block: Number(BigInt(landing.receipt.blockNumber)), verifyGas: Number(BigInt(landing.receipt.frameReceipts[0]!.gasUsed)), totalGas: Number(BigInt(landing.receipt.gasUsed)), attempts: landing.attempts });
  return { landing, harborHolds, ok: framesSucceeded(landing.receipt), stateGas: Number(BigInt(frame.stateGasUsed)) };
};
const oldBytes = await preFixV2Factory(deployer, "VajraAccountV2.pre-section-26");
const control = await swept(await ownerOf("tokens swept first, with a token that writes one slot", { factory: oldBytes, tokens: [await placeToken(ONE_SLOT_TOKEN)] }));
check(control.ok && control.harborHolds > parseEther("1.9"), `before, the control: the same bytes and a token that writes one slot, and the harbor holds ${formatEther(control.harborHolds)} ETH`);
const firstOrder = await ownerOf("tokens swept first, as on the public devnet", { factory: oldBytes, tokens: [await placeToken()] });
const firstResult = await swept(firstOrder);
check(!firstResult.ok && firstResult.harborHolds === 0n, `before: the frame halted, the harbor holds nothing, and the rescue's one-time key is spent. State gas used: ${firstResult.stateGas}`);
const eaten = await placeToken();
const lastOrder = await ownerOf("tokens swept last", { tokens: [eaten] });
const lastResult = await swept(lastOrder);
check(lastResult.ok && lastResult.harborHolds > parseEther("1.9") && lastResult.stateGas === 281_520, `after: the same token, the harbor holds ${formatEther(lastResult.harborHolds)} ETH, and the frame spent exactly a fresh harbor and the pool closing: ${lastResult.stateGas} state gas`);
const told = await checkRescue(lastOrder.rescue);
check(told.state === "sent" && told.leftBehind.length === 1 && told.leftBehind[0]!.toLowerCase() === eaten.toLowerCase(), "and the tool says it landed, and that the token did not move");

const result = {
  ranAt: new Date().toISOString(),
  stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
  chainId: DEVNET.chainId,
  genesis: deployments().genesis,
  holder: "a real process, `vajra nominee-watch`, started with an empty state folder, which it left empty",
  queueDelaySeconds: 60,
  marginSeconds: 15,
  rescueGas,
  secondsToSpareWhenTheNetworkFailed: spare,
  secondsLeftWhenTheRescueLanded: secondsLeft,
  thiefTransactionsSentMeanwhile: pins,
  thiefPendingInTheNodesPool: { lookedTimes: pendingSeen.length, seenTimes: pendingSeen.filter(Boolean).length, inTheLastFive: pendingSeen.slice(-5).filter(Boolean).length },
  stateSpendingToken: { sweptFirst: { framesSucceeded: firstResult.ok, harborHolds: formatEther(firstResult.harborHolds), stateGas: firstResult.stateGas }, sweptLast: { framesSucceeded: lastResult.ok, harborHolds: formatEther(lastResult.harborHolds), stateGas: lastResult.stateGas } },
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
