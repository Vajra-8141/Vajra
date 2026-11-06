/**
 * leanSphincs-S, measured live on the mirror: its gas, its size, and whether it fits in a VERIFY frame, beside the hash key it would
 * sit next to, on the same chain, in the same run. Then whether it really removes the one-time key problem, and every attack we could
 * think of on the path it runs on.
 *
 * Nothing in VajraAccountV2 changes for this. `setExit` takes any address, so a real account can name a sender that holds this key.
 *
 * The signatures are real, from `packages/core/src/leansphincs.ts`, which matches upstream's vectors byte for byte. The verifier is
 * upstream's, unchanged. The gas rows come from ethrex_simulateFrameTransaction, as in docs/GAS.md, and each shape is then mined.
 */
import { createHash, randomBytes } from "node:crypto";
import { cpus } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, bytesToHex, concat, decodeErrorResult, encodeFunctionData, formatEther, hexToBytes, keccak256, parseEther, toHex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  type Call,
  DEFAULT_FEES,
  DEVNET,
  ETH,
  type FrameTx,
  LEGACY_GAS_PRICE,
  MasterSigner,
  RpcError,
  Scope,
  accountAbi,
  accountState,
  createExit,
  dailyTx,
  deployments,
  encodedSize,
  exitTx,
  framesSucceeded,
  isLocalStack,
  leafNonceKey,
  masterDigest,
  masterTx,
  ops,
  opsV2,
  profile,
  publicClient,
  receiptOf,
  sendAlt,
  sendCanonical,
  sigHash,
  signDaily,
  signDailyTx,
  signExitTx,
  simulate,
  sleep,
  submit,
  txHash,
  waitForSuccess,
  walletFor,
  withMasterSignature,
} from "@vajra/core";
import { LEAN_SPHINCS_S_BYTES, LIGHT_B, LIGHT_RATED_SIGNATURES, type LeanSphincsKey, coverBits, keccakCalls, leanSphincsKeygen, leanSphincsPublicKey, leanSphincsSign } from "@vajra/core/leansphincs";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { check, evidence, master, mined, newAccount, newSigner, preFixV2Factory, refused, refusals, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this runs on the local mirror only, with VAJRA_STACK=local");

const SAMPLES = Number(process.env.SAMPLES ?? 24);
const UPSTREAM = { repository: "https://github.com/nconsigny/SPHINCs-", commit: "4c76aaf113d326df9adede63d015f3b394ab84f4", verifierSha256: "5d8e024fe23be273a78d1f4fdacf269f8ffdde9773f7b417a42ea70bf5a161c8" };

const started = Date.now();
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../core/src/artifacts/${name}.json`, import.meta.url), "utf8")) as { abi: never; bytecode: Hex };
const benchAbi = artifact("LeanSphincsBench").abi;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]!, mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
};

// ------------------------------------------------------------------------------------------------ the key

console.log("\n1. The key: Light tier, in TypeScript on one thread");
const verifierSource = readFileSync(new URL("../../../contracts/src/bench/LeanSphincsSAsm.sol", import.meta.url));
check(createHash("sha256").update(verifierSource).digest("hex") === UPSTREAM.verifierSha256, `the verifier is upstream's file at ${UPSTREAM.commit.slice(0, 7)}, unchanged`);

const seed = new Uint8Array(randomBytes(32));
const keygenCalls = keccakCalls();
const keygenAt = performance.now();
const key = leanSphincsKeygen(seed);
const keygen = { ms: Math.round(performance.now() - keygenAt), keccakCalls: keccakCalls() - keygenCalls };
const word = bytesToHex(leanSphincsPublicKey(key));
const cacheBytes = key.cache.length * 16;
console.log(`  public key ${word}\n  keygen ${keygen.keccakCalls} keccak calls, ${keygen.ms} ms. A ${cacheBytes}-byte cache to keep with the seed`);

const signingMs: number[] = [];
const signingCalls: number[] = [];

/** Signs what `validateExit` rebuilds: the same digest form as `VajraExit`, with this sender's address in it. */
function sign(tx: FrameTx, a: { key?: LeanSphincsKey; epochSalt: Hex; asSender?: Address }): FrameTx {
  const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: a.epochSalt, account: a.asSender ?? tx.sender, nonceKey: tx.nonceKeys[0]!, sigHash: sigHash(tx) });
  const before = keccakCalls();
  const at = performance.now();
  const signature = leanSphincsSign(a.key ?? key, hexToBytes(digest));
  signingMs.push(performance.now() - at);
  signingCalls.push(keccakCalls() - before);
  return withMasterSignature(tx, bytesToHex(signature));
}

// ---------------------------------------------------------------------------------------------- deployment

console.log("\n2. What it costs to put on chain");
const wallet = walletFor(deployer);
async function place(name: string, args: unknown[]) {
  const { abi, bytecode } = artifact(name);
  const receipt = await waitForSuccess(await wallet.deployContract({ abi, bytecode, args: args as never, gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), `deploying ${name}`);
  const address = receipt.contractAddress!;
  const code = await publicClient.getCode({ address });
  const row = { address, deployGas: Number(receipt.gasUsed), runtimeBytes: code ? hexToBytes(code).length : null };
  console.log(`  ${name} ${address}: ${row.deployGas} gas, ${row.runtimeBytes} bytes of code`);
  return row;
}
const verifier = await place("LeanSphincsSAsm", []);
const implementation = await place("LeanSphincsBench", [verifier.address]);
const factory = await place("VajraExitFactory", [implementation.address]);

// -------------------------------------------------------------------------------------------------- set up

console.log("\n3. Two real V2 accounts, each with a thief's 0.6 ETH in the queue, and each naming a sender for its second route");
async function route(name: string, makeExit: (account: Address, epochSalt: Hex) => Promise<Address>, accountFactory?: Address) {
  const masterTree = newSigner();
  const dailyKey = generatePrivateKey();
  const daily = privateKeyToAccount(dailyKey).address;
  const harbor = fresh();
  const harborSalt = keccak256(toHex(name));
  const account = await newAccount(deployer, masterTree, daily, harbor, harborSalt, parseEther("2"), accountFactory);
  const { epochSalt } = await accountState(account);
  const exit = await makeExit(account, epochSalt);
  await mined(`${name}: the master key names the exit`, master(masterTree, account, epochSalt, [opsV2.setExit(exit)]));
  await mined(`${name}: the thief queues 0.6 ETH`, await signDaily({ key: dailyKey, dailyKey: daily, account, calls: [ops.spend(ETH, fresh(), parseEther("0.6"))] }));
  return { name, masterTree, dailyKey, daily, harbor, harborSalt, account, epochSalt, exit };
}

const hashKeyGenAt = performance.now();
const exitTree: MasterSigner = newSigner();
const hashKeyGenMs = Math.round(performance.now() - hashKeyGenAt);
const hashKey = await route("hash key exit", (account, epochSalt) => createExit(deployer, deployments().v2!.exitFactory!, account, exitTree.root, epochSalt, parseEther("0.05")));
const lean = await route("leanSphincs-S exit", (account, epochSalt) => createExit(deployer, factory.address, account, word, epochSalt, parseEther("0.05")));
const { epochSalt } = lean;
/** `account` zero, so `validateMaster`'s shape, with money of its own. */
const masterSender = await createExit(deployer, factory.address, zeroAddress, word, epochSalt, parseEther("1"));

const linearNonce = async (sender: Address) => BigInt(await publicClient.getTransactionCount({ address: sender }));

/** `exitTx` builds the frames. A stateless key has no leaf, so the nonce is the caller's to pick. Linear unless told otherwise. */
const unsigned = (sender: Address, target: Address, calls: Call[], nonce: { seq: bigint; key?: bigint }, fees = DEFAULT_FEES, verifyGas?: bigint): FrameTx => ({
  ...exitTx({ exit: sender, account: target, root: word, leaf: 0, calls, fees, verifyGas }),
  nonceKeys: [nonce.key ?? 0n],
  nonceSeq: nonce.seq,
});
const signedBy = (sender: Address, target: Address, calls: Call[], nonce: { seq: bigint; key?: bigint }, fees = DEFAULT_FEES, verifyGas?: bigint) =>
  sign(unsigned(sender, target, calls, nonce, fees, verifyGas), { epochSalt });
const randomNonceKey = () => BigInt(bytesToHex(randomBytes(32)));

// ------------------------------------------------------------------------------------------------- the rows

console.log(`\n4. The gas rows, ${SAMPLES} fresh digests each, from ethrex_simulateFrameTransaction`);
type Row = ReturnType<typeof stats>;
const rows: Record<string, { verify: Row; wholeTx: Row; maxCostEth: string; signatureBytes: number; encodedBytes: number; canonical: string; alt: string }> = {};

async function sampled(name: string, build: (i: number) => FrameTx) {
  const verify: number[] = [];
  const whole: number[] = [];
  const canonical = new Set<string>();
  const alt = new Set<string>();
  const verdict = (v: { admitted: boolean | null; reason?: string | null }) => (v.admitted === null ? `unknown: ${v.reason}` : v.admitted ? "admitted" : `refused: ${v.reason}`);
  let last: Awaited<ReturnType<typeof simulate>> | undefined;
  let tx: FrameTx | undefined;
  for (let i = 0; i < SAMPLES; i++) {
    tx = build(i);
    last = await simulate(tx);
    canonical.add(verdict(last.canonical));
    alt.add(verdict(last.alt));
    const ok = last.frames?.every((frame) => frame.succeeded);
    if (!ok) check(false, `${name}, sample ${i}: ${last.executionError ?? JSON.stringify(last.frames)}`);
    else {
      verify.push(Number(BigInt(last.frames![0]!.gasUsed)));
      whole.push(Number(BigInt(last.gasUsed!)));
    }
  }
  rows[name] = {
    verify: stats(verify),
    wholeTx: stats(whole),
    maxCostEth: formatEther(BigInt(last!.maxCost)),
    signatureBytes: hexToBytes(tx!.signatures[0]!.signature).length,
    encodedBytes: encodedSize(tx!),
    canonical: [...canonical].join("; "),
    alt: [...alt].join("; "),
  };
  const r = rows[name]!;
  console.log(`  ${name}: VERIFY ${r.verify.min} / ${r.verify.median} / ${r.verify.max}, whole tx ${r.wholeTx.median}, ${r.signatureBytes} B signature, canonical ${r.canonical}, alt ${r.alt}`);
}

// An address that already exists, or every row would carry the 183,600 state gas of creating one.
const PAYEE = "0x000000000000000000000000000000000000dEaD";
await waitForSuccess(await wallet.sendTransaction({ to: PAYEE, value: 1n, gas: 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "creating the payee");
const payment = (i: number): Call => ({ data: "0x", target: PAYEE, value: 1n, execution: 300_000n + BigInt(i), state: 300_000n });
await sampled("hash key, V2 validateMaster, new nonce key, a payment", (i) => master(hashKey.masterTree, hashKey.account, hashKey.epochSalt, [payment(i)]));
await sampled("leanSphincs-S, master shape, new nonce key, a payment", (i) => signedBy(masterSender, masterSender, [payment(i)], { seq: 0n, key: randomNonceKey() }));

const heldKey = randomNonceKey();
await mined("leanSphincs-S, master shape: the first transaction on a nonce key it keeps", signedBy(masterSender, masterSender, [payment(0)], { seq: 0n, key: heldKey }));
await sampled("leanSphincs-S, master shape, nonce key used before, a payment", (i) => signedBy(masterSender, masterSender, [payment(i)], { seq: 1n, key: heldKey }));
const masterLinear = await linearNonce(masterSender);
await sampled("leanSphincs-S, master shape, linear nonce, a payment", (i) => signedBy(masterSender, masterSender, [payment(i)], { seq: masterLinear }));

const tweak = (call: Call, i: number): Call => ({ ...call, execution: call.execution + BigInt(i) });
const exitNonce = await linearNonce(lean.exit);
const hashKeySignMs: number[] = [];
function signedByTree(calls: Call[]) {
  const at = performance.now();
  const { tx } = signExitTx({ signer: exitTree, exit: hashKey.exit, account: hashKey.account, epochSalt: hashKey.epochSalt, calls });
  hashKeySignMs.push(performance.now() - at);
  return tx;
}
await sampled("hash key, VajraExit, veto", () => signedByTree([ops.veto(0n)]));
await sampled("leanSphincs-S, exit shape, linear nonce, veto", (i) => signedBy(lean.exit, lean.account, [tweak(ops.veto(0n), i)], { seq: exitNonce }));
// What the hash key's row pays, for the same frames. The limit is raised so that the number can be read, and the verdicts show what that limit does.
await sampled("leanSphincs-S, exit shape, new nonce key, veto", (i) => signedBy(lean.exit, lean.account, [tweak(ops.veto(0n), i)], { seq: 0n, key: randomNonceKey() }, DEFAULT_FEES, 120_000n));
await sampled("hash key, VajraExit, escape", () => signedByTree([ops.escape(hashKey.harbor, hashKey.harborSalt)]));
await sampled("leanSphincs-S, exit shape, linear nonce, escape", (i) => signedBy(lean.exit, lean.account, [tweak(ops.escape(lean.harbor, lean.harborSalt), i)], { seq: exitNonce }));

// -------------------------------------------------------------------------------------------------- attacks

/** The attack has to die at admission, with this name. */
async function refusedByBench(attack: string, tx: FrameTx, want: string) {
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
        name = (decodeErrorResult({ abi: benchAbi, data }) as { errorName: string }).errorName;
      } catch {}
    }
    check(name === want, `${attack}: ${name === want ? name : `${message.slice(0, 220)} (wanted ${want})`}`);
    refusals.push({ attack, refusal: name.slice(0, 200) });
  }
}

console.log("\n5. Attacks on the leanSphincs-S sender");
const veto = ops.veto(0n);
const asExit = (calls: Call[]) => signedBy(lean.exit, lean.account, calls, { seq: exitNonce });
const honest = asExit([veto]);
const signature = honest.signatures[0]!.signature;
const withBytes = (tx: FrameTx, blob: Hex) => withMasterSignature(tx, blob);
function flipped(offset: number) {
  const bytes = hexToBytes(signature);
  bytes[offset]! ^= 1;
  return withBytes(honest, bytesToHex(bytes));
}
for (const [field, offset] of [["randomizer", 0], ["a FORS secret", 16], ["a FORS path", 32], ["the counter", 2720], ["a WOTS value", 2724], ["the auth path", 3748], ["the last byte", LEAN_SPHINCS_S_BYTES - 1]] as const) {
  await refusedByBench(`One bit of ${field} flipped`, flipped(offset), "BadSignature");
}
const otherKey = leanSphincsKeygen(new Uint8Array(randomBytes(32)));
await refusedByBench("A signature from another key", sign(unsigned(lean.exit, lean.account, [veto], { seq: exitNonce }), { key: otherKey, epochSalt }), "BadSignature");
await refusedByBench("The real key, signing for the account's address instead of this sender's", sign(unsigned(lean.exit, lean.account, [veto], { seq: exitNonce }), { epochSalt, asSender: lean.account }), "BadSignature");
await refusedByBench("The real key, signing under another epoch", sign(unsigned(lean.exit, lean.account, [veto], { seq: exitNonce }), { epochSalt: keccak256(toHex("another epoch")) }), "BadSignature");
await refusedByBench("A signature for a veto, moved onto a freeze", withBytes(unsigned(lean.exit, lean.account, [ops.freeze()], { seq: exitNonce }), signature), "BadSignature");
await refusedByBench("A copy with its SENDER frame's gas cut, so that it dies", { ...honest, frames: honest.frames.map((f, i) => (i === 1 ? { ...f, limits: { ...f.limits, execution: 1000n } } : f)) }, "BadSignature");
await refusedByBench("A copy with a higher fee, to burn the reserve", { ...honest, fees: { ...honest.fees, maxFeePerGas: honest.fees.maxFeePerGas * 2n } }, "BadSignature");
// FINDINGS section 16: frame 0 was outside what a wallet signed. Here the signature hash holds it, and the rest of the transaction.
const frame0 = honest.frames[0]!;
await refusedByBench("A copy with frame 0's data padded", { ...honest, frames: [{ ...frame0, data: concat([frame0.data, "0x00"]) }, honest.frames[1]!] }, "BadSignature");
await refusedByBench("A copy with frame 0's limit cut, to trade it for padding", { ...honest, frames: [{ ...frame0, limits: { ...frame0.limits, execution: frame0.limits.execution - 64n } }, honest.frames[1]!] }, "BadSignature");
const unchanged = sigHash(honest);
check(sigHash({ ...honest, blobVersionedHashes: [keccak256(toHex("a blob"))] }) !== unchanged, "A blob hash added to a copy changes the signature hash");
check(sigHash({ ...honest, recentRootReferences: [{ sourceId: keccak256(toHex("a source")), slot: 1n, root: keccak256(toHex("a root")) }] }) !== unchanged, "A recent-root reference added to a copy changes the signature hash");
await refusedByBench("A copy on another nonce key", { ...honest, nonceKeys: [randomNonceKey()], nonceSeq: 0n }, "BadSignature");
const entry = honest.signatures[0]!;
await refusedByBench("A copy with a message put in the signature entry", { ...honest, signatures: [{ ...entry, msg: keccak256(toHex("a message")) }] }, "BadSignature");
await refusedByBench("A copy with a second signature entry", { ...honest, signatures: [entry, entry] }, "BadSignature");
const onMasterSender = sign(unsigned(masterSender, lean.account, [veto], { seq: exitNonce }), { epochSalt });
await refusedByBench("A signature from one sender, moved to another holding the same key", { ...onMasterSender, sender: lean.exit }, "BadSignature");

await refusedByBench("A copy padded by one byte, to burn the reserve", withBytes(honest, concat([signature, "0x00"])), "SignatureLengthInvalid");
await refusedByBench("A copy padded by 8 KB, to burn the reserve", withBytes(honest, concat([signature, bytesToHex(new Uint8Array(8192))])), "SignatureLengthInvalid");
await refusedByBench("A signature one byte short", withBytes(honest, bytesToHex(hexToBytes(signature).subarray(0, LEAN_SPHINCS_S_BYTES - 1))), "SignatureLengthInvalid");
await refusedByBench("No signature at all", withBytes(honest, "0x"), "SignatureLengthInvalid");

for (const [what, call] of [
  ["to unfreeze", ops.unfreeze()],
  ["to replace the daily key", ops.setDailyKey(fresh())],
  ["to move the harbor", ops.setHarbor(keccak256(toHex("thief harbor")))],
  ["a spend", ops.spend(ETH, fresh(), 1n)],
  ["to queue a root with no proof", opsV2.queueRecovery(keccak256(toHex("thief root")), 1n)],
  ["to move value in a frame", { ...ops.freeze(), value: 1n }],
  ["a frame to another contract", { ...ops.freeze(), target: fresh() }],
] as const) {
  await refusedByBench(`The exit key tries ${what}`, asExit([call as Call]), "FrameNotAllowed");
}
// `sender_approved` covers every SENDER frame, so an allowed call in front must not carry a forbidden one behind it: FINDINGS section 6.
for (const [what, call] of [
  ["a spend", ops.spend(ETH, fresh(), 1n)],
  ["an unfreeze", ops.unfreeze()],
  ["a root with no proof", opsV2.queueRecovery(keccak256(toHex("thief root")), 1n)],
] as const) {
  await refusedByBench(`The exit key sends a veto with ${what} behind it`, asExit([veto, call]), "FrameNotAllowed");
}
const asDefault = lib.frame(profile, "DEFAULT", { target: lean.account, execution: 80_000n, data: veto.data });
await refusedByBench("The exit key sends a DEFAULT frame", sign({ ...unsigned(lean.exit, lean.account, [veto], { seq: exitNonce }), frames: [unsigned(lean.exit, lean.account, [], { seq: exitNonce }).frames[0]!, asDefault] }, { epochSalt }), "FrameNotAllowed");

// Someone else's transaction, with this sender as its paymaster. `VajraExit` refuses this, so that its key cannot spend the reserve on anything else.
const leaf = hashKey.masterTree.nextLeaf();
const foreign = masterTx({ account: hashKey.account, root: hashKey.masterTree.root, leaf, calls: [payment(0)] });
const paying = {
  ...foreign,
  frames: [
    lib.frame(profile, "VERIFY", { scope: "EXECUTION", execution: 99_900n, data: encodeFunctionData({ abi: accountAbi, functionName: "validateMaster", args: [Scope.Execution] }) }),
    lib.frame(profile, "VERIFY", { scope: "PAYMENT", target: lean.exit, execution: 99_900n, data: unsigned(lean.exit, lean.account, [], { seq: exitNonce }).frames[0]!.data }),
    foreign.frames[1]!,
  ],
};
const payingDigest = masterDigest({ chainId: DEVNET.chainId, epochSalt: hashKey.epochSalt, account: hashKey.account, nonceKey: leafNonceKey(hashKey.masterTree.root, leaf), sigHash: sigHash(paying) });
await refusedByBench("Its VERIFY frame aimed at it from another sender's transaction, to make its reserve pay", withMasterSignature(paying, hashKey.masterTree.sign(leaf, payingDigest)), "NotAuthorized");

await refusedByBench(
  "The daily key signs this sender's own VERIFY frame",
  await signDailyTx({ ...unsigned(lean.exit, lean.account, [veto], { seq: exitNonce }), signatures: [lib.secp256k1Placeholder(profile, lean.daily)] }, lean.dailyKey),
  "SignatureLengthInvalid",
);
await refusedByBench("The daily key sends from this sender's address", await signDailyTx({ ...dailyTx({ account: lean.account, dailyKey: lean.daily, nonce: exitNonce, calls: [ops.spend(ETH, lean.daily, 1n)] }), sender: lean.exit }, lean.dailyKey), "validation frame 0: reverted");
await refused("The daily key names an exit of its own", await signDaily({ key: lean.dailyKey, dailyKey: lean.daily, account: lean.account, calls: [opsV2.setExit(fresh())] }), "EscapeKeyOutranks");

// Section 9 of the findings: a claim tried on one kind of nonce, and true of that kind only. So the same again on the others, and on the shape with no walk.
async function onThisNonce(on: string, tx: FrameTx) {
  const blob = hexToBytes(tx.signatures[0]!.signature);
  blob[2724]! ^= 1;
  await refusedByBench(`${on}: one bit flipped`, withBytes(tx, bytesToHex(blob)), "BadSignature");
  await refusedByBench(`${on}: from another key`, sign(tx, { key: otherKey, epochSalt }), "BadSignature");
  await refusedByBench(`${on}: a copy with a higher fee`, { ...tx, fees: { ...tx.fees, maxFeePerGas: tx.fees.maxFeePerGas * 2n } }, "BadSignature");
  await refusedByBench(`${on}: a copy padded by one byte`, withBytes(tx, concat([tx.signatures[0]!.signature, "0x00"])), "SignatureLengthInvalid");
}
await onThisNonce("Exit shape, a keyed nonce", signedBy(lean.exit, lean.account, [veto], { seq: 0n, key: randomNonceKey() }));
await refusedByBench("Exit shape, a keyed nonce: the exit key tries a spend", signedBy(lean.exit, lean.account, [ops.spend(ETH, fresh(), 1n)], { seq: 0n, key: randomNonceKey() }), "FrameNotAllowed");
await onThisNonce("No walk, the linear nonce", signedBy(masterSender, masterSender, [payment(0)], { seq: await linearNonce(masterSender) }));
await onThisNonce("No walk, a keyed nonce", signedBy(masterSender, masterSender, [payment(0)], { seq: 0n, key: randomNonceKey() }));

// ---------------------------------------------------------------------------------------------- the routes

/** Into ethrex's own mempool, the one with the 100,000 cap, and then wait. */
async function minedCanonical(step: string, tx: FrameTx, onAdmitted?: () => Promise<void>) {
  const hash = await sendCanonical(tx);
  await onAdmitted?.();
  let receipt = await receiptOf(txHash(tx));
  for (let i = 0; i < 40 && !receipt; i++) {
    await sleep(1000);
    receipt = await receiptOf(txHash(tx));
  }
  if (!receipt) return check(false, `${step}: admitted ${hash}, not mined`);
  const verifyGas = Number(BigInt(receipt.frameReceipts[0]!.gasUsed));
  const totalGas = Number(BigInt(receipt.gasUsed));
  evidence.push({ step, hash, block: Number(BigInt(receipt.blockNumber)), verifyGas, totalGas, attempts: 1 });
  check(framesSucceeded(receipt), `${step}: ${hash}, VERIFY ${verifyGas} gas, ${totalGas} in all`);
}

console.log("\n6. Each shape, really mined");
const keyedOnce = signedBy(masterSender, masterSender, [payment(0)], { seq: 0n, key: randomNonceKey() });
await minedCanonical("leanSphincs-S, master shape, new nonce key, through the canonical mempool", keyedOnce);
const keyedAgain = await sendAlt(keyedOnce).then(() => "ADMITTED", (error: Error) => error.message);
check(/nonce/i.test(keyedAgain), `The same bytes again, on a keyed nonce: ${keyedAgain.slice(0, 120)}`);
refusals.push({ attack: "The same bytes again, on a keyed nonce", refusal: keyedAgain.slice(0, 200) });
await mined("leanSphincs-S, master shape, new nonce key, through the alt mempool", signedBy(masterSender, masterSender, [payment(0)], { seq: 0n, key: randomNonceKey() }));
await mined("leanSphincs-S, master shape, nonce key used before, through the alt mempool", signedBy(masterSender, masterSender, [payment(0)], { seq: 1n, key: heldKey }));

async function vetoAndEscape(r: typeof lean, signFor: (calls: Call[]) => FrameTx | Promise<FrameTx>) {
  await mined(`${r.name}: veto, through the alt mempool`, await signFor([ops.veto(0n)]));
  const item = (await publicClient.readContract({ address: r.account, abi: artifact("VajraAccountV2").abi, functionName: "queuedItem", args: [0n] } as never)) as { state: number };
  check(item.state === 3, `${r.name}: the item is vetoed`);

  // Signed before anything else, because a signature can take longer than a slot, and the thief's transaction has to be pending when this goes in.
  const escape = await signFor([ops.escape(r.harbor, r.harborSalt)]);

  // A thief's transaction pending, as in `vajra exit-e2e`: the mempool that refuses the account's own escape.
  const head = await publicClient.getBlockNumber();
  while ((await publicClient.getBlockNumber()) === head) await sleep(100);
  const base = (await publicClient.getBlock()).baseFeePerGas ?? 7n;
  const nonce = await linearNonce(r.account);
  const pin = await signDailyTx(dailyTx({ account: r.account, dailyKey: r.daily, nonce, calls: [ops.spend(ETH, fresh(), 1n)], fees: { maxFeePerGas: base + 1n, maxPriorityFeePerGas: 0n } }), r.dailyKey);
  await sendCanonical(pin);
  const direct = master(r.masterTree, r.account, r.epochSalt, [ops.escape(r.harbor, r.harborSalt)]);
  const blocked = await sendCanonical(direct).then(() => "ADMITTED", (error: Error) => error.message);
  check(/other nonce-key domain/.test(blocked), `${r.name}: the account's own escape, canonical: ${blocked.slice(0, 100)}`);
  await minedCanonical(`${r.name}: escape past a thief's pending transaction, through the canonical mempool`, escape, async () => {
    check((await receiptOf(txHash(pin))) === null, `${r.name}: the thief's transaction was still pending when the escape was admitted`);
  });
  const landed = await publicClient.getBalance({ address: r.harbor });
  check(landed > parseEther("1.9"), `${r.name}: the harbor holds ${formatEther(landed)} ETH`);
}
await vetoAndEscape(hashKey, (calls) => signExitTx({ signer: exitTree, exit: hashKey.exit, account: hashKey.account, epochSalt: hashKey.epochSalt, calls }).tx);
await vetoAndEscape(lean, async (calls) => signedBy(lean.exit, lean.account, calls, { seq: await linearNonce(lean.exit) }));
const replayed = await sendAlt(honest).then(() => "ADMITTED", (error: Error) => error.message);
check(/nonce/i.test(replayed), `The first veto's signature, resent after the sender's nonce moved: ${replayed.slice(0, 120)}`);
refusals.push({ attack: "A signature resent after the sender's nonce moved", refusal: replayed.slice(0, 200) });

// ------------------------------------------------------------------------------------------- the hypothesis

console.log("\n7. Does it remove the one-time key problem?");
const message = hexToBytes(keccak256(toHex("the same message")));
check(bytesToHex(leanSphincsSign(key, message)) === bytesToHex(leanSphincsSign(key, message)), "The same message gives the same bytes");

// A one-time key may not do this: two different signatures from one leaf let anyone forge a third.
const before = await linearNonce(masterSender);
const revealed = signedBy(masterSender, masterSender, [payment(1)], { seq: before });
const revealedOutcome = await simulate(revealed);
check(revealedOutcome.frames?.[0]?.succeeded === true, "Revealed to a node, and never mined");
const second = signedBy(masterSender, masterSender, [payment(2)], { seq: before });
await mined("Another transaction on the same nonce, signed after that", second);

// A bump. Sent just after a block, so that the first is still pending.
const head = await publicClient.getBlockNumber();
while ((await publicClient.getBlockNumber()) === head) await sleep(100);
const bumpNonce = await linearNonce(masterSender);
const low = signedBy(masterSender, masterSender, [payment(3)], { seq: bumpNonce });
const high = signedBy(masterSender, masterSender, [payment(3)], { seq: bumpNonce }, { maxFeePerGas: DEFAULT_FEES.maxFeePerGas * 2n, maxPriorityFeePerGas: DEFAULT_FEES.maxPriorityFeePerGas! * 2n });
await sendAlt(low);
const bumped = await sendAlt(high).then(() => "admitted", (error: Error) => error.message);
const feeBump = { outcome: bumped, lowMined: false, highMined: false };
if (bumped === "admitted") {
  const landed = await submit(high, { log: (l) => console.log(`    ${l}`) });
  feeBump.highMined = framesSucceeded(landed.receipt);
  feeBump.lowMined = (await receiptOf(txHash(low))) !== null;
  check(feeBump.highMined && !feeBump.lowMined, `The same payment signed again at twice the fee replaced the first: ${landed.hash}`);
} else {
  check(false, `The same payment signed again at twice the fee: ${bumped.slice(0, 200)}`);
}

const restored = leanSphincsKeygen(seed);
check(bytesToHex(leanSphincsPublicKey(restored)) === word, "A copy of the seed on a second device gets the same key, with nothing to reconcile");
await mined("Signed by that copy, which knows nothing of what the first signed", sign(unsigned(masterSender, masterSender, [payment(4)], { seq: await linearNonce(masterSender) }), { key: restored, epochSalt }));

// The price of signing twice being safe: only one transaction can land on one nonce. On two nonce keys, both can, and anyone holding the first can send it.
const firstKey = randomNonceKey();
const payOnce = (key: bigint) => signedBy(masterSender, masterSender, [payment(5)], { seq: 0n, key });
const onFirstKey = payOnce(firstKey);
const payeeBefore = await publicClient.getBalance({ address: PAYEE });
await mined("A retry of one payment, on a new nonce key", payOnce(randomNonceKey()));
await mined("The first attempt, sent later, and it still lands", onFirstKey);
check((await publicClient.getBalance({ address: PAYEE })) === payeeBefore + 2n, "So a retry on a new nonce key pays twice. A stateless key has to keep one nonce, and replace");

console.log("\n8. What V2 trusted a named exit with, and the fix");
// On the bytes before FINDINGS section 21, which are kept so that this stays reproducible. `VajraExit` refuses `queueRecovery` in its walk, and on these
// bytes that walk was all that held the selector back: the account asked only that the caller be named.
const named = await route("before the fix, a sender with no walk, named by mistake", async () => masterSender, await preFixV2Factory(deployer, "VajraAccountV2.pre-section-21"));
const chosenRoot = keccak256(toHex("a root the holder of this sender's key chose"));
const noPaper = await mined("Before the fix, no proof and no paper: queueRecovery, then executeQueued, in one transaction", signedBy(masterSender, named.account, [opsV2.queueRecovery(chosenRoot, 1n), ops.executeQueued(1n)], { seq: await linearNonce(masterSender) }));
const treeNow = await publicClient.readContract({ address: named.account, abi: artifact("VajraAccountV2").abi, functionName: "wotsRoot" } as never);
check(treeNow === chosenRoot, "Before the fix, the account's master tree is replaced, at once");

const fixedTree = newSigner();
const fixedAccount = await newAccount(deployer, fixedTree, fresh(), fresh(), keccak256(toHex("after the fix")), parseEther("1"));
const naming = await simulate(master(fixedTree, fixedAccount, epochSalt, [opsV2.setExit(masterSender)]));
check(naming.frames?.[1]?.succeeded === false, "After the fix, the master key cannot name it: its SENDER frame fails with ExitNotForThisAccount");
refusals.push({ attack: "After the fix, the master key names a sender with no walk", refusal: "ExitNotForThisAccount, in the SENDER frame" });
const namingReal = await simulate(master(fixedTree, fixedAccount, epochSalt, [opsV2.setExit(await createExit(deployer, factory.address, fixedAccount, word, epochSalt, parseEther("0.01")))]));
check(namingReal.frames?.[1]?.succeeded === true, "After the fix, it can still name a sender that holds to this account");

const lifetime = Object.fromEntries([64, 1_000, LIGHT_RATED_SIGNATURES, 43_715, 100_000].map((n) => [n, Number(coverBits(n).toFixed(1))]));
console.log(`  What is left is a lifetime. Upstream's estimate after N signatures on the Light tier, in bits, under a ceiling of 128 from the hash size: ${JSON.stringify(lifetime)}`);

// ----------------------------------------------------------------------------------------------------- record

const result = {
  ranAt: new Date().toISOString(),
  stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. NOT run on the public devnet",
  chainId: DEVNET.chainId,
  genesis: deployments().genesis,
  method: "ethrex_simulateFrameTransaction for the rows, a fresh digest per sample, then each shape mined",
  upstream: UPSTREAM,
  scheme: { name: "leanSphincs-S over keccak256", n: 16, h: 26, d: 1, a: 12, k: 13, w: 4, targetSum: 128, signatureBytes: LEAN_SPHINCS_S_BYTES, publicKeyBytes: 32 },
  signer: {
    code: "packages/core/src/leansphincs.ts, written from the spec, TypeScript with @noble/hashes, one thread. Upstream's Rust signer was not run",
    tier: `Light: b = ${LIGHT_B}, rated ${LIGHT_RATED_SIGNATURES} signatures by upstream, an estimate`,
    machine: `${cpus()[0]?.model}, node ${process.version}`,
    keygen,
    cacheBytes,
    signMs: stats(signingMs.map(Math.round)),
    signKeccakCalls: stats(signingCalls),
    theHashKeyBesideIt: { keygenMs: hashKeyGenMs, signMs: stats(hashKeySignMs.map((ms) => Number(ms.toFixed(1)))) },
  },
  deployment: { verifier, implementation, factory },
  rows,
  feeBump,
  lifetimeBitsAfterSignatures: lifetime,
  namedExitWithNoWalk: { what: "FINDINGS section 21: the flaw shown on purpose, on the bytes before the fix, with a sender only this run deploys. The same naming is refused after the fix", account: named.account, hash: noPaper.hash, masterTreeReplaced: treeNow === chosenRoot },
  publicKey: word,
  account: lean.account,
  exit: lean.exit,
  masterSender,
  failures: tally.failures,
  mined: evidence,
  refusals,
};
writeFileSync(new URL("../../../docs/evidence/leansphincs-gas-latest.json", import.meta.url), JSON.stringify(result, null, 1) + "\n");
console.log(`\nsigning: ${JSON.stringify(result.signer.signMs)} ms, ${JSON.stringify(result.signer.signKeccakCalls)} keccak calls`);
console.log(`\n${evidence.length} mined, ${refusals.length} refused, ${tally.failures} failures, ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(tally.failures ? 1 : 0);
