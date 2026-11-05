/**
 * The whole account, end to end, against the live devnet: real transactions through the real alt mempool, and every
 * attack the rulebook claims to stop, actually attempted. Exits non-zero if anything behaves differently from the
 * claim. Every mined transaction is recorded in docs/evidence/ so the evidence outlives the explorer's in-memory history.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { type Address, type Hex, bytesToHex, decodeErrorResult, hexToBytes, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import {
  DEVNET,
  ETH,
  KeyTree,
  LEGACY_GAS_PRICE,
  LeafAlreadyRevealed,
  MasterSigner,
  RpcError,
  WOTS_W16,
  accountAbi,
  accountState,
  createAccount,
  dailyTx,
  deployments,
  encodeMasterSignature,
  framesSucceeded,
  harborCommitment,
  leafNonceKey,
  loadOrCreateKey,
  masterDigest,
  masterTx,
  memoryStore,
  ops,
  publicClient,
  queuedEvents,
  sendAlt,
  sigHash,
  signDaily,
  signDailyTx,
  signMasterTx,
  simulate,
  submit,
  type Call,
  type FrameTx,
  waitForSuccess,
  walletFor,
  walletMessage,
  withMasterSignature,
  withWalletSignature,
  wotsSign,
} from "@vajra/core";
import { keyPath } from "./deploy.ts";

const MAX_HASHES = 660;
const evidence: { step: string; hash: Hex; block: number; verifyGas: number; totalGas: number; attempts: number }[] = [];
const refusals: { attack: string; refusal: string }[] = [];
let failures = 0;

const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

async function mined(step: string, tx: FrameTx) {
  const { hash, receipt, attempts } = await submit(tx, { log: (l) => console.log(`    ${l}`) });
  const verifyGas = Number(BigInt(receipt.frameReceipts[0]!.gasUsed));
  evidence.push({ step, hash, block: Number(receipt.blockNumber), verifyGas, totalGas: Number(BigInt(receipt.gasUsed)), attempts });
  check(framesSucceeded(receipt), `${step}: ${hash} block ${Number(receipt.blockNumber)}, VERIFY ${verifyGas} gas`);
  return { hash, receipt };
}

/** What a refusal actually says, as the account's own error name rather than a hex blob. */
function refusalName(message: string): string {
  const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined;
  if (!data) return message;
  try {
    return decodeErrorResult({ abi: accountAbi, data }).errorName;
  } catch {
    return message;
  }
}

/** The attack has to die at the door, and for exactly the claimed reason. */
async function refused(attack: string, tx: FrameTx, expected: string | RegExp) {
  try {
    const hash = await sendAlt(tx);
    check(false, `${attack}: ADMITTED ${hash}`);
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    const name = refusalName(error.message);
    const ok = typeof expected === "string" ? name === expected : expected.test(name);
    check(ok, `${attack}: ${name}`);
    refusals.push({ attack, refusal: name });
  }
}

const key = loadOrCreateKey(keyPath("deployer.key"));
const { w16, genesis } = deployments();

const dailyPrivate = generatePrivateKey();
const daily = privateKeyToAccount(dailyPrivate).address;
const harborPrivate = generatePrivateKey();
const harbor = privateKeyToAccount(harborPrivate).address;
const friendPrivate = generatePrivateKey();
const friend = privateKeyToAccount(friendPrivate).address;
const thief = privateKeyToAccount(generatePrivateKey()).address;
const harborSalt = keccak256(toHex(`harbor ${Date.now()}`));
const seed = crypto.getRandomValues(new Uint8Array(32));
const signer = new MasterSigner(WOTS_W16, memoryStore(), () => seed);

const LIMIT = parseEther("0.001");
const ALLOWANCE = parseEther("0.0004");
const QUEUE_DELAY = 45n;
const COOLING = 30n;
const waitSeconds = (s: bigint) => new Promise((r) => setTimeout(r, Number(s) * 1000));

console.log("creating an account");
const account = await createAccount(
  key,
  w16.factory,
  {
    dailyKey: daily,
    wotsRoot: signer.root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(harbor, harborSalt),
    queueDelay: QUEUE_DELAY,
    coolingPeriod: COOLING,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [LIMIT],
    coolingAllowances: [ALLOWANCE],
  },
  parseEther("0.02"),
);
console.log(`account ${account}, daily key ${daily}`);
const balance = (address: Address) => publicClient.getBalance({ address });

let activeSigner = signer;
const master = (calls: Call[]) => signMasterTx({ signer: activeSigner, account, epochSalt: genesis, calls, maxHashes: MAX_HASHES }).tx;
const dailySigned = (calls: Call[]) => signDaily({ key: dailyPrivate, dailyKey: daily, account, calls });
const queuedIn = (receipt: Awaited<ReturnType<typeof mined>>["receipt"]) => queuedEvents(receipt.frameReceipts[1]!.logs as { topics: Hex[]; data: Hex }[]);

console.log("\n1. the daily key spends under the rules");
await mined("daily spend inside the cooling allowance", await dailySigned([ops.spend(ETH, friend, parseEther("0.0003"))]));
check((await balance(friend)) === parseEther("0.0003"), "the payee received the spend");

console.log("\n2. a first-time payee is capped by cooling");
{
  const { receipt } = await mined("spend above the cooling allowance", await dailySigned([ops.spend(ETH, thief, parseEther("0.0005"))]));
  check((await balance(thief)) === 0n, "nothing reached the fresh address");
  check(queuedIn(receipt)[0]?.reason === 1, "queued with reason NewPayeeCoolingActive");
}

console.log("\n3. a spend over the daily limit is queued, in public, and the master key vetoes it");
await waitSeconds(COOLING);
let vetoTx: FrameTx;
{
  const { receipt } = await mined("spend above the daily limit", await dailySigned([ops.spend(ETH, friend, parseEther("0.005"))]));
  const [event] = queuedIn(receipt);
  check(event?.reason === 0, "queued with reason DailyLimitExceeded");
  vetoTx = master([ops.veto(event!.id)]);
  await mined("master veto", vetoTx);
  const item = (await publicClient.readContract({ address: account, abi: accountAbi, functionName: "queuedItem", args: [event!.id] })) as { state: number };
  check(item.state === 3, "the item is vetoed");
}

console.log("\n4. every way a stolen daily key might reach past its rank");
await refused("daily key calls escape", await dailySigned([ops.escape(thief, harborSalt)]), "EscapeKeyOutranks");
await refused("daily key changes the harbor", await dailySigned([ops.setHarbor(keccak256("0x01"))]), "HarborImmutable");
await refused("daily key rotates the master tree", await dailySigned([ops.rotateRoot(keccak256("0x02"))]), "EscapeKeyOutranks");
await refused("daily key raises its own limit", await dailySigned([ops.setRule(ETH, parseEther("100"), parseEther("100"))]), "EscapeKeyOutranks");
await refused("daily key replaces itself", await dailySigned([ops.setDailyKey(thief)]), "EscapeKeyOutranks");
await refused("daily key vetoes", await dailySigned([ops.veto(0n)]), "EscapeKeyOutranks");
await refused(
  "daily key adds a second SENDER frame straight to the thief",
  await dailySigned([ops.spend(ETH, friend, 1n), { target: thief, data: "0x", value: parseEther("0.003"), execution: 50_000n, state: 200_000n }]),
  "FrameNotAllowed",
);
await refused(
  "daily key attaches value to its call to the account",
  await dailySigned([{ ...ops.spend(ETH, friend, 1n), value: parseEther("0.003") }]),
  "FrameNotAllowed",
);
{
  const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
  const tx = dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, thief, 1n)] });
  const expensive = { ...tx, fees: { ...tx.fees, maxFeePerGas: 1_000_000_000_000n, maxPriorityFeePerGas: 1_000_000_000_000n } };
  await refused("daily key burns the balance through fees", await signDailyTx(expensive, dailyPrivate), "DailyTxCostExceeded");
}

console.log("\n5. an outsider with no key at all");
{
  const stranger = generatePrivateKey();
  const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
  const forged = await signDailyTx(dailyTx({ account, dailyKey: privateKeyToAccount(stranger).address, nonce, calls: [ops.spend(ETH, thief, 1n)] }), stranger);
  await refused("a stranger signs as the daily key", forged, "NotDailyKey");
}
{
  // Any signature the key ever made must be worthless here, even one for a message that has nothing to do with this.
  const old = keccak256(toHex("a message the owner once signed on some website"));
  const s = await sign({ hash: old, privateKey: dailyPrivate });
  const packed = `0x${(s.yParity ?? 0).toString(16).padStart(2, "0")}${s.r.slice(2)}${s.s.slice(2)}` as Hex;
  const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
  const tx = dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, thief, parseEther("0.0001"))] });
  await refused(
    "an old signature over an unrelated message",
    { ...tx, signatures: [{ ...tx.signatures[0]!, msg: old, signature: packed }] },
    "SignatureNotBoundToTransaction",
  );
}

console.log("\n6. one-time keys, layer by layer");
{
  const used = signer.nextLeaf() - 1;
  try {
    signMasterTx({ signer, account, epochSalt: genesis, calls: [ops.freeze()], leaf: used });
    check(false, "the signer signed a second message with a revealed leaf");
  } catch (error) {
    check(error instanceof LeafAlreadyRevealed, `layer 1, the signer: ${(error as Error).message}`);
  }

  await refused("layer 2: the mined veto, replayed byte for byte", vetoTx, /nonce/i);

  // A compromised signer: this skips MasterSigner entirely and produces a genuine second signature from a spent leaf.
  const tree = KeyTree.fromSeed(WOTS_W16, seed);
  const forge = (nonceSeq: bigint) => {
    const base = { ...masterTx({ account, root: signer.root, leaf: used, calls: [ops.freeze()] }), nonceSeq };
    const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: genesis, account, nonceKey: leafNonceKey(signer.root, used), sigHash: sigHash(base) });
    const sig = wotsSign(WOTS_W16, seed, used, hexToBytes(digest));
    return withMasterSignature(base, bytesToHex(encodeMasterSignature(used, sig, tree.path(used))));
  };
  await refused("layer 2: a valid new signature from a spent leaf, at sequence 0", forge(0n), /nonce/i);
  await refused("layer 3: the same at the leaf's next sequence, which the protocol alone would allow", forge(1n), "LeafAlreadySpent");
}

console.log("\n6b. a stock wallet as the daily key");
{
  // MetaMask cannot sign a type-0x06 transaction, but it can personal_sign 32 bytes. `signMessage` over raw bytes is
  // the same call a browser wallet answers.
  const wallet = privateKeyToAccount(dailyPrivate);
  const nonce = BigInt(await publicClient.getTransactionCount({ address: account }));
  const unsigned = dailyTx({ account, dailyKey: daily, nonce, calls: [ops.spend(ETH, friend, parseEther("0.00001"))] });
  const signature = await wallet.signMessage({ message: { raw: walletMessage(unsigned) } });
  await mined("daily spend signed with personal_sign", withWalletSignature(unsigned, signature));

  const next = BigInt(await publicClient.getTransactionCount({ address: account }));
  const honest = dailyTx({ account, dailyKey: daily, nonce: next, calls: [ops.spend(ETH, friend, 1n)] });
  const approved = await wallet.signMessage({ message: { raw: walletMessage(honest) } });

  const swapped = { ...withWalletSignature(honest, approved), frames: dailyTx({ account, dailyKey: daily, nonce: next, calls: [ops.spend(ETH, thief, 1n)] }).frames };
  await refused("a wallet signature moved onto a different recipient", swapped, "SignatureNotBoundToTransaction");

  const stranger = privateKeyToAccount(generatePrivateKey());
  const forged = await stranger.signMessage({ message: { raw: walletMessage(honest) } });
  await refused("personal_sign from any other key", withWalletSignature(honest, forged), /signature/i);
}

console.log("\n6c. rotating the key tree");
{
  const root = signer.root;
  const nextSeed = crypto.getRandomValues(new Uint8Array(32));
  const next = new MasterSigner(WOTS_W16, memoryStore(), () => nextSeed);

  const misuse = signMasterTx({ signer, account, epochSalt: genesis, calls: [ops.freeze()], rotation: true, maxHashes: MAX_HASHES }).tx;
  await refused("the reserved rotation leaf, used for anything else", misuse, "TreeExhausted");

  // That leaf is now revealed, so rotation uses an ordinary leaf here. The spec's reserved leaf exists for the day the
  // others run out, and this run has just spent it on proving it cannot be misused.
  await mined("master rotates to a new tree", master([ops.rotateRoot(next.root)]));
  const after = await accountState(account);
  check(after.wotsRoot === next.root && after.wotsRoot !== root, "the account has the new root");

  await refused(
    "the old tree after rotation",
    signMasterTx({ signer, account, epochSalt: genesis, calls: [ops.freeze()], maxHashes: MAX_HASHES }).tx,
    "NonceKeyNotBoundToLeaf",
  );

  const unfreezeWithNewTree = signMasterTx({ signer: next, account, epochSalt: genesis, calls: [ops.setHarbor(harborCommitment(harbor, harborSalt))], maxHashes: MAX_HASHES }).tx;
  await mined("the new tree signs", unfreezeWithNewTree);
  activeSigner = next;
}

console.log("\n7. the panic button");
await mined("master freeze", master([ops.freeze()]));
check((await accountState(account)).frozen, "the account is frozen");
await refused("a daily spend while frozen", await dailySigned([ops.spend(ETH, friend, 1n)]), "AccountFrozen");
await mined("master unfreeze", master([ops.unfreeze()]));

console.log("\n8. a queued item runs once it matures, and not before");
{
  const { receipt } = await mined("queue a large spend", await dailySigned([ops.spend(ETH, friend, parseEther("0.005"))]));
  const [event] = queuedIn(receipt);
  const execute = () =>
    walletFor(key).writeContract({ address: account, abi: accountAbi, functionName: "executeQueued", args: [event!.id], gas: 400_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined });
  const early = await publicClient
    .simulateContract({ address: account, abi: accountAbi, functionName: "executeQueued", args: [event!.id] })
    .then(
      () => "executed",
      (e: Error) => e.message,
    );
  check(early.includes("QueuedPendingTimelock"), "an early execute is refused: QueuedPendingTimelock");
  await waitSeconds(QUEUE_DELAY);
  const before = await balance(friend);
  await waitForSuccess(await execute(), "matured execute");
  check((await balance(friend)) - before === parseEther("0.005"), "the matured item paid out");
}

console.log("\n9. the escape");
{
  const escapeTx = master([ops.escape(harbor, harborSalt)]);
  const { maxCost } = await simulate(escapeTx);
  const { receipt } = await mined("master escape", escapeTx);
  const paid = BigInt(receipt.gasUsed) * BigInt((receipt as unknown as { effectiveGasPrice: Hex }).effectiveGasPrice);
  const left = await balance(account);
  // The balance leaves in the SENDER frame; the protocol then refunds the unused part of the prepaid gas to the payer.
  check(left === BigInt(maxCost) - paid, `all that remains is the gas refund: ${left} wei`);
  check((await balance(harbor)) > 0n, `the harbor holds ${await balance(harbor)} wei`);
  check((await accountState(account)).frozen, "the account stays frozen");
  await refused("the stolen key after the escape", await dailySigned([ops.spend(ETH, thief, 1n)]), "AccountFrozen");
}

// The faucet can run dry, so test funds go home.
for (const [from, label] of [[harborPrivate, "harbor"], [friendPrivate, "payee"]] as const) {
  const value = (await balance(privateKeyToAccount(from).address)) - 21_000n * LEGACY_GAS_PRICE;
  if (value > 0n) {
    await waitForSuccess(
      await walletFor(from).sendTransaction({ to: privateKeyToAccount(key).address, value, gas: 21_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }),
      `returning the ${label}'s funds`,
    );
  }
}

mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../docs/evidence/e2e-latest.json", import.meta.url),
  JSON.stringify({ chainId: DEVNET.chainId, at: new Date().toISOString(), account, implementation: w16.implementation, transactions: evidence, refusals }, null, 1) + "\n",
);
console.log(`\n${evidence.length} transactions mined, ${refusals.length} attacks refused, ${failures} failures`);
if (failures) process.exit(1);
