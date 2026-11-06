/**
 * Both paymasters on the mirror, on a V2 account: real transactions through the real alt mempool, and every attack actually sent. Exits
 * non-zero on any difference from the claim. A V2 account takes a sponsored daily transaction only from a paymaster its master key named.
 *
 * Every transaction here is also offered to the canonical mempool, which has to refuse it, and asked of `simulate` first. Its
 * verdict is then held against what the live sidecar did, so a wrong prediction is a failure like any other.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as lib from "@forshtat/hegota-support/tx";
import { type Address, type Hex, concat, encodeFunctionData, keccak256, parseEther, parseAbi, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ATOMIC_BATCH_FLAG,
  CHARGE_INDEX,
  DEVNET,
  ETH,
  type FrameReceipt,
  type FrameTx,
  LEGACY_GAS_PRICE,
  MasterSigner,
  RpcError,
  type Sponsor,
  WOTS_W16,
  createAccount,
  deployments,
  erc20Abi,
  explain,
  framesSucceeded,
  harborCommitment,
  isLocalStack,
  memoryStore,
  ops,
  opsV2,
  publicClient,
  quotaPaymasterAbi,
  quotaPaymasterBytecode,
  readPrice,
  readQuota,
  receiptOf,
  sendAlt,
  sendCanonical,
  signSponsoredDaily,
  signSponsoredMaster,
  simulate,
  sleep,
  sponsorRefusal,
  submit,
  txHash,
  profile,
  usdcPaymasterAbi,
  waitForSuccess,
  walletFor,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { PAYMASTER_FEE_CAP, keyPath, stakePaymaster } from "./deploy.ts";

if (!isLocalStack) throw new Error("run this on the mirror, with VAJRA_STACK=local");

const deployer = loadOrCreateKey(keyPath("deployer.key"));
const owner = privateKeyToAccount(deployer).address;
const { v2, genesis, paymasters } = deployments();
if (!paymasters) throw new Error("no paymasters on this mirror: run `vajra deploy paymasters`");
if (!v2) throw new Error("no V2 on this mirror: run `vajra deploy zk`");
/** V2's own limit on a master signature's hashes: see FINDINGS section 15. */
const MAX_HASHES = 520;
/** `validateDaily` on V2 with the sponsored shape, with room. */
const V2_DAILY_VERIFY_GAS = 55_000n;

const QUOTA: Sponsor = { kind: "quota", paymaster: paymasters.quota };
const PRICE = BigInt(paymasters.usdcPerEth);
const USDC: Sponsor = { kind: "usdc", paymaster: paymasters.usdc, usdcPerEth: PRICE };
const usdc = DEVNET.usdc;
const plain = { gas: 1_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as const;

const evidence: { step: string; hash: Hex; block: number; gasUsed: number; charged: string; frames: number[] }[] = [];
const refusals: { attack: string; refusal: string; canonical?: string }[] = [];
const canonicalReasons = new Map<string, number>();
const tally = { failures: 0, predictions: 0, canonicalRefused: 0 };

const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) tally.failures++;
};

/** The canonical mempool refuses it for real, every time, and for a reason ethrex gives. */
async function offerCanonical(what: string, tx: FrameTx): Promise<string> {
  const reason = await sendCanonical(tx).then(
    (hash) => {
      check(false, `${what}: the canonical mempool ADMITTED it, ${hash}`);
      return "ADMITTED";
    },
    (error: Error) => error.message,
  );
  if (reason !== "ADMITTED") tally.canonicalRefused++;
  canonicalReasons.set(reason, (canonicalReasons.get(reason) ?? 0) + 1);
  return reason;
}

async function mined(step: string, tx: FrameTx, opts: { body?: "ok" | "fails"; charged?: () => Promise<bigint> } = {}) {
  const predicted = await simulate(tx);
  check(predicted.alt.admitted === true, `simulate says the alt mempool admits it: ${predicted.alt.rule ?? "no rule failed"} ${predicted.alt.reason ?? ""}`);
  check(predicted.canonical.admitted === false, `simulate says the canonical mempool refuses it: ${predicted.canonical.rule}`);
  tally.predictions += 2;
  const canonical = await offerCanonical(step, tx);
  check(canonical !== "ADMITTED", `canonical refuses: ${canonical.slice(0, 110)}`);

  const { hash, receipt } = await submit(tx, { log: (l) => console.log(`    ${l}`) });
  const frames = receipt.frameReceipts.map((f) => Number(BigInt(f.gasUsed)) + Number(BigInt(f.stateGasUsed)));
  evidence.push({ step, hash, block: Number(BigInt(receipt.blockNumber)), gasUsed: Number(BigInt(receipt.gasUsed)), charged: "", frames });
  if ((opts.body ?? "ok") === "ok") check(framesSucceeded(receipt), `${step}: ${hash} block ${Number(BigInt(receipt.blockNumber))}, ${Number(BigInt(receipt.gasUsed))} gas`);
  else check(receipt.frameReceipts[3]?.status === "0x0" && receipt.frameReceipts.at(-1)?.status === "0x1", `${step}: mined, the body failed and settle ran, ${hash}, ${Number(BigInt(receipt.gasUsed))} gas`);

  const told = await explain(hash);
  check(told.state === "mined" && told.alt.admitted === true && told.alt.source === "explorer" && told.canonical.admitted === false, `explain: mined, alt ${told.alt.admitted} (${told.checks?.length ?? "no"} rules recorded), canonical ${told.canonical.admitted} at the parent block`);
  return { hash, receipt };
}

/** The attack has to die at the door, with this name, and `simulate` and `explain` have to say the same. */
async function refused(attack: string, tx: FrameTx, expected: string | RegExp, opts: { rule?: string; replay?: boolean } = {}) {
  const matches = (name: string | null) => (name !== null && (typeof expected === "string" ? name === expected : expected.test(name)));
  const predicted = await simulate(tx);
  const canonical = await offerCanonical(attack, tx);
  try {
    const hash = await sendAlt(tx);
    check(false, `${attack}: ADMITTED ${hash}`);
    refusals.push({ attack, refusal: "ADMITTED" });
    return;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    const name = sponsorRefusal(error.message);
    check(matches(name), `${attack}: ${name.slice(0, 160)}`);
    refusals.push({ attack, refusal: name.slice(0, 200), canonical: canonical.slice(0, 200) });

    tally.predictions++;
    const said = predicted.alt.refusal ?? predicted.alt.reason;
    check(predicted.alt.admitted === false && matches(said), `simulate predicted it: ${predicted.alt.rule}, ${said?.slice(0, 120)}`);
    if (predicted.alt.fix) console.log(`       fix: ${predicted.alt.fix}`);

    // A byte-for-byte replay has the hash of what was mined, and that is what explain says.
    const told = await explain(txHash(tx));
    const record = told.alt.refusal ?? told.alt.reason;
    if (opts.replay) check(told.state === "mined", "explain: this hash is the one that was mined");
    else check(told.state === "rejected" && told.alt.rule === predicted.alt.rule && matches(record), `explain agrees: rule ${told.alt.rule}`);
    if (opts.rule) check(told.alt.rule === opts.rule, `the rule is ${opts.rule}`);
  }
}

/** A call that has to revert, named. */
async function reverts(attack: string, want: string, call: { account: Address; address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] }) {
  const outcome = await publicClient.simulateContract(call as never).then(() => "allowed", (error: Error) => error.message);
  check(outcome.includes(want), `${attack}: ${outcome.includes(want) ? want : outcome.slice(0, 200)}`);
  refusals.push({ attack, refusal: outcome.includes(want) ? want : outcome.slice(0, 200) });
}

const owned = walletFor(deployer);
const asOwner = async (address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) =>
  waitForSuccess(await owned.writeContract({ address, abi: abi as never, functionName, args, ...plain } as never), functionName);

const enroll = (paymaster: Address, account: Address, dailyGas: bigint) => asOwner(paymaster, quotaPaymasterAbi, "enroll", [account, dailyGas]);
const giveUsdc = (to: Address, amount: bigint) => asOwner(usdc, erc20Abi, "transfer", [to, amount]);
const usdcOf = (who: Address) => publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const ethOf = (address: Address) => publicClient.getBalance({ address });
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const place = async (args: unknown[]) =>
  (await waitForSuccess(await owned.deployContract({ abi: quotaPaymasterAbi as never, bytecode: quotaPaymasterBytecode, args: args as never, gas: 30_000_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" }), "placing a paymaster")).contractAddress!;

/** Pays for the master transaction that names the paymasters, so that the accounts here never hold ETH and the two under test start clean. */
const SETUP: Sponsor = { kind: "quota", paymaster: await place([owner, DEVNET.stakingRegistry, PAYMASTER_FEE_CAP, 86_400]) };
await stakePaymaster(deployer, SETUP.paymaster);

/** An account holding no ETH at all: nothing here can be paid for by the account itself. */
async function newAccount(usdcAmount = 0n, named: Address[] = [paymasters!.quota, paymasters!.usdc]) {
  const dailyKey = generatePrivateKey();
  const daily = privateKeyToAccount(dailyKey).address;
  const signer = new MasterSigner(WOTS_W16, memoryStore(), () => crypto.getRandomValues(new Uint8Array(32)));
  const account = await createAccount(
    deployer,
    v2!.factory,
    {
      dailyKey: daily,
      wotsRoot: signer.root,
      epochSalt: genesis,
      harborCommitment: harborCommitment(fresh(), keccak256(toHex("harbor"))),
      queueDelay: 3600n,
      coolingPeriod: 0n,
      maxDailyTxCost: parseEther("0.01"),
      assets: [ETH, usdc],
      dailyLimits: [parseEther("1"), 1_000_000_000_000n],
      coolingAllowances: [parseEther("1"), 1_000_000_000_000n],
    },
    0n,
  );
  if (usdcAmount > 0n) await giveUsdc(account, usdcAmount);
  const signMaster = (calls: Parameters<typeof signSponsoredMaster>[0]["calls"], sponsor: Sponsor) => signSponsoredMaster({ signer, account, epochSalt: genesis, calls, sponsor, maxHashes: MAX_HASHES }).tx;
  const name = async (...sponsors: Address[]) => {
    await enroll(SETUP.paymaster, account, 20_000_000n);
    await submit(signMaster(sponsors.map((s) => opsV2.setSponsor(s)), SETUP));
  };
  if (named.length > 0) await name(...named);
  const pay = (to: Address, amount: bigint) => ops.spend(usdc, to, amount);
  const daily_ = (a: { calls: Parameters<typeof signSponsoredDaily>[0]["calls"]; sponsor?: Sponsor } & Partial<Parameters<typeof signSponsoredDaily>[0]>) =>
    signSponsoredDaily({ key: dailyKey, dailyKey: daily, account, sponsor: QUOTA, verifyGas: V2_DAILY_VERIFY_GAS, ...a });
  const master = (calls: Parameters<typeof signSponsoredMaster>[0]["calls"], sponsor: Sponsor = QUOTA) => signMaster(calls, sponsor);
  return { account, daily, dailyKey, signer, pay, sponsoredDaily: daily_, master, name };
}

/** `Call`s the master key can make to the token, with limits that fit. */
const tokenCall = (functionName: "approve" | "transfer", to: Address, amount: bigint) => ({
  target: usdc,
  data: encodeFunctionData({ abi: erc20Abi, functionName, args: [to, amount] }),
  execution: 90_000n,
  state: 120_000n,
});

const payeeSpend = (account: Awaited<ReturnType<typeof newAccount>>, to: Address, amount: bigint) => ({ ...account.pay(to, amount), execution: 150_000n, state: 450_000n });
const effective = (receipt: FrameReceipt) => BigInt((receipt as unknown as { effectiveGasPrice: Hex }).effectiveGasPrice);
const paidWei = (receipt: FrameReceipt) => BigInt(receipt.gasUsed) * effective(receipt);

/** Quota charged for a transaction has to cover its real gas, and the paymaster has to have paid exactly that gas. */
async function quotaMined(step: string, paymaster: Address, account: Address, tx: FrameTx, opts: { body?: "ok" | "fails" } = {}) {
  const was = await readQuota(paymaster, account);
  const today = (await publicClient.readContract({ address: paymaster, abi: quotaPaymasterAbi, functionName: "day" })) as bigint;
  const before = was.day === today ? was.used : 0n;
  const ethBefore = await ethOf(paymaster);
  const { receipt, hash } = await mined(step, tx, opts);
  const after = await readQuota(paymaster, account);
  const charged = after.used - before;
  const gas = BigInt(receipt.gasUsed);
  check(charged >= gas, `the quota paid for it: charged ${charged} for ${gas} real gas`);
  check(ethBefore - (await ethOf(paymaster)) === paidWei(receipt), `the paymaster paid exactly the real cost, ${paidWei(receipt)} wei`);
  evidence.find((e) => e.hash === hash)!.charged = `${charged} gas of quota`;
  return { receipt, charged };
}

/** USDC kept has to cover the ETH paid, at the signed price. */
async function usdcMined(step: string, account: Address, tx: FrameTx, opts: { body?: "ok" | "fails"; price?: bigint } = {}) {
  const pm = paymasters!.usdc;
  const [usdcBefore, ethBefore] = [await usdcOf(pm), await ethOf(pm)];
  const { receipt, hash } = await mined(step, tx, opts);
  const kept = (await usdcOf(pm)) - usdcBefore;
  const paid = ethBefore - (await ethOf(pm));
  const floor = (paid * (opts.price ?? PRICE) + 10n ** 18n - 1n) / 10n ** 18n;
  check(paid === paidWei(receipt), `the paymaster paid exactly the real cost, ${paid} wei`);
  check(kept >= floor, `it kept ${kept} USDC units for gas worth ${floor} at the set price`);
  check((await ethOf(account)) === 0n, "the account still holds no ETH");
  evidence.find((e) => e.hash === hash)!.charged = `${kept} USDC units`;
  return { receipt, kept };
}

const SPEND = 1_000_000n;
const dropFrame = (tx: FrameTx, index: number): FrameTx => ({ ...tx, frames: tx.frames.filter((_, i) => i !== (index < 0 ? tx.frames.length + index : index)) });
/** Bytes a frame ignores, which the signature covers and the calldata floor charges for. */
const stuffCharge = (tx: FrameTx, bytes: number): FrameTx => ({
  ...tx,
  frames: tx.frames.map((f, i) => (i === Number(CHARGE_INDEX) ? { ...f, data: concat([f.data, toHex(new Uint8Array(bytes).fill(0x5a))]) } : f)),
});

// ---------------------------------------------------------------------------------------------------------------------------

console.log("the quota paymaster");
const staked = await publicClient.readContract({
  address: DEVNET.stakingRegistry,
  abi: parseAbi(["function getDepositInfo(address) view returns (uint256, uint32, uint64)"]),
  functionName: "getDepositInfo",
  args: [paymasters.quota],
});
check(staked[0] > parseEther("0.01"), `it is staked: ${staked[0]} wei, unstake delay ${staked[1]}s`);

console.log("\n1. an enrolled account with no ETH spends, and the paymaster pays");
const alice = await newAccount(50_000_000n);
await enroll(paymasters.quota, alice.account, 20_000_000n);
{
  const payee = fresh();
  await quotaMined("sponsored daily spend", paymasters.quota, alice.account, await alice.sponsoredDaily({ calls: [alice.pay(payee, SPEND)] }));
  check((await usdcOf(payee)) === SPEND, "the payee received the spend");
  check((await ethOf(alice.account)) === 0n, "the account holds no ETH and never did");
}

console.log("\n2. every way to get more than the quota");
{
  const bob = await newAccount(50_000_000n);
  const gasOf = await bob.sponsoredDaily({ calls: [payeeSpend(bob, fresh(), SPEND)] });
  const limit = (await simulate(gasOf)).maxCost;
  const maxGas = BigInt(limit) / gasOf.fees.maxFeePerGas;
  // Room for the maximum twice over less what the first gives back, and no third.
  await enroll(paymasters.quota, bob.account, maxGas * 2n);
  await quotaMined("first spend under the quota", paymasters.quota, bob.account, await bob.sponsoredDaily({ calls: [payeeSpend(bob, fresh(), SPEND)] }));
  await quotaMined("second spend under the quota", paymasters.quota, bob.account, await bob.sponsoredDaily({ calls: [payeeSpend(bob, fresh(), SPEND)] }));
  await refused("the third spend of the day", await bob.sponsoredDaily({ calls: [payeeSpend(bob, fresh(), SPEND)] }), "OverQuota");
  const after = await readQuota(paymasters.quota, bob.account);
  check(after.used <= after.quota, `used ${after.used} of ${after.quota}`);

  const carl = await newAccount(50_000_000n);
  await enroll(paymasters.quota, carl.account, 500_000n);
  await refused("one transaction whose limits are over the whole quota", await carl.sponsoredDaily({ calls: [carl.pay(fresh(), SPEND)] }), "OverQuota");

  // Two at once, on different nonce keys. Both pass admission on the same remaining quota. Only what runs first can land.
  const dana = await newAccount(50_000_000n);
  const first = dana.master([payeeSpend(dana, fresh(), SPEND)]);
  const second = dana.master([payeeSpend(dana, fresh(), SPEND)]);
  const room = BigInt((await simulate(first)).maxCost) / first.fees.maxFeePerGas;
  await enroll(paymasters.quota, dana.account, room + 1_000n);
  const one = await sendAlt(first);
  const two = await sendAlt(second);
  const waiting = await explain(two);
  check(waiting.state === "pending" && waiting.alt.admitted === true, `explain, while it waits: ${waiting.state}, the sidecar admitted it`);
  check(one === txHash(first) && two === txHash(second), "both were admitted on the same remaining quota");
  await sleep(14_000);
  const landed = (await Promise.all([receiptOf(one), receiptOf(two)])).filter((r) => r);
  check(landed.length === 1, `${landed.length} of the two landed`);
  const left = await readQuota(paymasters.quota, dana.account);
  check(left.used <= left.quota, `the quota held: used ${left.used} of ${left.quota}`);
  refusals.push({ attack: "two transactions at once on one remaining quota", refusal: `${landed.length} of 2 mined, the other OverQuota at inclusion` });
}

console.log("\n3. a real cost above what the frames imply");
{
  const erin = await newAccount(50_000_000n);
  await enroll(paymasters.quota, erin.account, 30_000_000n);
  await quotaMined(
    "8 KB of ignored data, so that the calldata floor sets the cost",
    paymasters.quota,
    erin.account,
    await erin.sponsoredDaily({ calls: [payeeSpend(erin, fresh(), SPEND)], edit: (tx) => stuffCharge(tx, 8_000) }),
  );
  await quotaMined(
    "a body that burns its whole limit and fails",
    paymasters.quota,
    erin.account,
    await erin.sponsoredDaily({ calls: [{ ...erin.pay(fresh(), SPEND), execution: 8_000n, state: 0n }] }),
    { body: "fails" },
  );
}

console.log("\n4. starved, missing and misplaced frames");
const spend = () => alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)] });
await refused("the charge frame given too little gas to run", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], limits: { charge: { execution: 20_000n, state: 0n } } }), "ChargeFrameStarved");
await refused("the charge frame given too little gas to reach its own check", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], limits: { charge: { execution: 3_000n, state: 0n } } }), /ran out of gas/);
await refused("the settle frame given too little gas to run", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], limits: { settle: { execution: 40_000n, state: 0n } } }), "SettleFrameStarved");
await refused("no charge frame at all", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], edit: (tx) => dropFrame(tx, 1) }), "ChargeFrameMissing");
await refused("no settle frame", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], edit: (tx) => dropFrame(tx, -1) }), "SettleFrameMissing");
await refused(
  "settle moved before the body, which would refund the body's whole limit",
  await alice.sponsoredDaily({
    calls: [alice.pay(fresh(), SPEND)],
    edit: (tx) => {
      const frames = [...tx.frames];
      const [settle] = frames.splice(-1, 1);
      frames.splice(3, 0, settle!);
      return { ...tx, frames };
    },
  }),
  "FrameNotAllowed",
);
await refused(
  "settle pointed at the wrong frame",
  await alice.sponsoredDaily({
    calls: [alice.pay(fresh(), SPEND)],
    edit: (tx) => ({
      ...tx,
      frames: tx.frames.map((f, i) => (i === tx.frames.length - 1 ? { ...f, data: encodeFunctionData({ abi: quotaPaymasterAbi, functionName: "settle", args: [3n] }) } : f)),
    }),
  }),
  "SettleFrameMissing",
);
await refused(
  "the charge frame sent to some other contract",
  await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], edit: (tx) => ({ ...tx, frames: tx.frames.map((f, i) => (i === 1 ? { ...f, target: usdc } : f)) }) }),
  /prefix not recognized/,
);
{
  // What a daily signature could approve before, with nothing named: no DEFAULT frame at all.
  const unnamed = await newAccount(50_000_000n, []);
  await enroll(paymasters.quota, unnamed.account, 20_000_000n);
  await refused("a sponsored daily transaction on an account whose master key named no paymaster", await unnamed.sponsoredDaily({ calls: [unnamed.pay(fresh(), SPEND)] }), "FrameNotAllowed");
  await refused("a paymaster the master key did not name, on an account that named another", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], sponsor: SETUP }), "FrameNotAllowed");
  await refused("the daily key names a paymaster itself", await alice.sponsoredDaily({ calls: [opsV2.setSponsor(fresh())] }), "EscapeKeyOutranks");
  const body = await alice.sponsoredDaily({
    calls: [alice.pay(fresh(), SPEND)],
    edit: (tx) => ({ ...tx, frames: [...tx.frames.slice(0, 3), lib.frame(profile, "DEFAULT", { target: paymasters.quota, execution: 40_000n, data: encodeFunctionData({ abi: quotaPaymasterAbi, functionName: "charge" }) }), ...tx.frames.slice(3)] }),
  });
  await refused("a DEFAULT frame in the body, even to a named paymaster", body, "FrameNotAllowed");
}

console.log("\n5. fees, enrolment, replay");
await refused("a fee above the paymaster's cap", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], fees: { maxFeePerGas: PAYMASTER_FEE_CAP + 1n, maxPriorityFeePerGas: PAYMASTER_FEE_CAP + 1n } }), "FeeTooHigh");
await refused("a tip paid to a colluding block producer", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], fees: { maxFeePerGas: 500_000_000_000n, maxPriorityFeePerGas: 500_000_000_000n } }), "DailyTxCostExceeded");
{
  const stranger = await newAccount(50_000_000n);
  await refused("an account nobody enrolled", await stranger.sponsoredDaily({ calls: [stranger.pay(fresh(), SPEND)] }), "NotEnrolled");
  const removed = await newAccount(50_000_000n);
  await enroll(paymasters.quota, removed.account, 20_000_000n);
  await enroll(paymasters.quota, removed.account, 0n);
  await refused("an account the owner removed", await removed.sponsoredDaily({ calls: [removed.pay(fresh(), SPEND)] }), "NotEnrolled");
}
{
  const once = await spend();
  await quotaMined("a spend, to replay", paymasters.quota, alice.account, once);
  // The nonce is what stops it. The sidecar words this one from ethrex's first canonical violation, as in section 10 below.
  await refused("the mined spend, replayed byte for byte", once, /prefix gas budget exceeded/, { replay: true });
  check(/[Nn]once/.test((await simulate(once)).alt.reason ?? ""), "simulate gives the real cause next to it: the nonce");
  const used = await readQuota(paymasters.quota, alice.account);
  const stolen = privateKeyToAccount(generatePrivateKey());
  await refused("a stranger signs for an enrolled account", await signSponsoredDaily({ key: generatePrivateKey(), dailyKey: stolen.address, account: alice.account, calls: [alice.pay(fresh(), SPEND)], sponsor: QUOTA, verifyGas: V2_DAILY_VERIFY_GAS }).catch(() => once), /NotDailyKey|signature/i);
  check((await readQuota(paymasters.quota, alice.account)).used === used.used, "none of that moved the quota");
}

console.log("\n6. calling the paymaster from outside a frame");
await reverts("a body or a plain call charges someone", "NotEntryPoint", { account: fresh(), address: paymasters.quota, abi: quotaPaymasterAbi, functionName: "charge" });
await reverts("a body or a plain call settles", "NotEntryPoint", { account: fresh(), address: paymasters.quota, abi: quotaPaymasterAbi, functionName: "settle", args: [1n] });
await reverts("a stranger enrols themselves", "NotOwner", { account: fresh(), address: paymasters.quota, abi: quotaPaymasterAbi, functionName: "enroll", args: [fresh(), 1n] });
await reverts("a stranger withdraws the float", "NotOwner", { account: fresh(), address: paymasters.quota, abi: quotaPaymasterAbi, functionName: "withdraw", args: [fresh(), 1n] });
await reverts("a stranger raises the fee cap", "NotOwner", { account: fresh(), address: paymasters.quota, abi: quotaPaymasterAbi, functionName: "setFeeCap", args: [1n] });
await reverts("a stranger moves the stake", "NotOwner", { account: fresh(), address: paymasters.quota, abi: quotaPaymasterAbi, functionName: "callRegistry", args: ["0x"] });

console.log("\n7. the stake is what gets it admitted");
{
  const bare = await place([owner, DEVNET.stakingRegistry, PAYMASTER_FEE_CAP, 86_400]);
  await enroll(bare, alice.account, 20_000_000n);
  await alice.name(bare);
  const sponsor: Sponsor = { kind: "quota", paymaster: bare };
  await refused("the same contract with no ETH", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], sponsor }), /reverted|has 0 wei|maximum cost/);
  await waitForSuccess(await owned.sendTransaction({ to: bare, value: parseEther("1"), ...plain }), "funding it");
  await refused("the same contract with no stake", await alice.sponsoredDaily({ calls: [alice.pay(fresh(), SPEND)], sponsor }), /unstaked payer accessed/, { rule: "storage" });

  // 8. A short window, to watch one close. `TIMESTAMP` is banned in validation, so nothing moves until someone says so.
  console.log("\n8. the day turns over, with a 40 second day");
  const WINDOW = 40n;
  const short = await place([owner, DEVNET.stakingRegistry, PAYMASTER_FEE_CAP, WINDOW]);
  await stakePaymaster(deployer, short);
  const fred = await newAccount(50_000_000n, [short]);
  const shortSponsor: Sponsor = { kind: "quota", paymaster: short };
  const probe = await fred.sponsoredDaily({ calls: [payeeSpend(fred, fresh(), SPEND)], sponsor: shortSponsor });
  await enroll(short, fred.account, (BigInt((await simulate(probe)).maxCost) / probe.fees.maxFeePerGas) * 11n / 10n);
  const dayOf = () => publicClient.readContract({ address: short, abi: quotaPaymasterAbi, functionName: "day" }) as Promise<bigint>;
  // Start just after a boundary, so that the second attempt below cannot fall in the next window.
  for (;;) {
    const now = (await publicClient.getBlock()).timestamp;
    if (now % WINDOW < 8n) break;
    await sleep(1000);
  }
  await waitForSuccess(await walletFor(deployer).writeContract({ address: short, abi: quotaPaymasterAbi as never, functionName: "roll", ...plain } as never), "rolling");
  await quotaMined("a spend that takes most of the day's quota", short, fred.account, await fred.sponsoredDaily({ calls: [payeeSpend(fred, fresh(), SPEND)], sponsor: shortSponsor }));
  await refused("the next spend, the same day", await fred.sponsoredDaily({ calls: [payeeSpend(fred, fresh(), SPEND)], sponsor: shortSponsor }), "OverQuota");
  const before = await dayOf();
  for (;;) {
    if ((await publicClient.getBlock()).timestamp / WINDOW > before) break;
    await sleep(1000);
  }
  await refused("a new day that nobody has announced: still the old day's total", await fred.sponsoredDaily({ calls: [payeeSpend(fred, fresh(), SPEND)], sponsor: shortSponsor }), "OverQuota");
  const anyone = generatePrivateKey();
  await waitForSuccess(await owned.sendTransaction({ to: privateKeyToAccount(anyone).address, value: parseEther("0.01"), ...plain }), "funding a stranger");
  await waitForSuccess(await walletFor(anyone).writeContract({ address: short, abi: quotaPaymasterAbi as never, functionName: "roll", ...plain } as never), "a stranger rolls the day");
  check((await dayOf()) > before, "anyone can announce it, and it can only move to the real day");
  await quotaMined("the quota is back", short, fred.account, await fred.sponsoredDaily({ calls: [payeeSpend(fred, fresh(), SPEND)], sponsor: shortSponsor }));
}

// ---------------------------------------------------------------------------------------------------------------------------

console.log("\nthe USDC paymaster");
const price = await readPrice(paymasters.usdc);
check(price.usdcPerEth === PRICE, `price ${price.usdcPerEth} units per ETH: "${price.label}"`);
check(/not a market price/i.test(price.label), "the contract says what the price is");

const APPROVAL = 1_000_000_000n;
/** An account with USDC and no ETH, whose master key approved the paymaster, with the quota paymaster paying for that. */
async function usdcAccount(amount: bigint) {
  const a = await newAccount(amount);
  await enroll(paymasters!.quota, a.account, 20_000_000n);
  await submit(a.master([tokenCall("approve", paymasters!.usdc, APPROVAL)]));
  return a;
}
const tokenSpend = (a: Awaited<ReturnType<typeof newAccount>>, to: Address, amount: bigint) => a.sponsoredDaily({ calls: [a.pay(to, amount)], sponsor: USDC });

console.log("\n9. gas paid in USDC, by an account with no ETH");
const gina = await usdcAccount(100_000_000n);
{
  const payee = fresh();
  const before = await usdcOf(gina.account);
  const tx = await tokenSpend(gina, payee, SPEND);
  const max = (BigInt((await simulate(tx)).maxCost) * PRICE + 10n ** 18n - 1n) / 10n ** 18n;
  const { kept } = await usdcMined("a spend with gas paid in USDC", gina.account, tx);
  check((await usdcOf(payee)) === SPEND, "the payee received the spend");
  check(before - (await usdcOf(gina.account)) === SPEND + kept, `the account paid the spend and ${kept} for gas, of ${max} taken first`);
  check(kept < max, `settle gave back ${max - kept} units`);
}

console.log("\n10. every way to take the gas and not pay");
{
  const henry = await newAccount(100_000_000n);
  await refused("no approval", await tokenSpend(henry, fresh(), SPEND), "InsufficientAllowance");
  const iris = await newAccount(0n);
  await refused("no USDC", await iris.sponsoredDaily({ calls: [iris.pay(fresh(), 0n)], sponsor: USDC }), "InsufficientUsdc");
}
await refused("the repay frame starved of gas", await gina.sponsoredDaily({ calls: [gina.pay(fresh(), SPEND)], sponsor: USDC, limits: { charge: { execution: 40_000n, state: 120_000n } } }), "ChargeFrameStarved");
await refused("the repay frame starved of state gas", await gina.sponsoredDaily({ calls: [gina.pay(fresh(), SPEND)], sponsor: USDC, limits: { charge: { execution: 160_000n, state: 0n } } }), "ChargeFrameStarved");
await refused("the refund frame starved", await gina.sponsoredDaily({ calls: [gina.pay(fresh(), SPEND)], sponsor: USDC, limits: { settle: { execution: 40_000n, state: 0n } } }), "SettleFrameStarved");
await refused("no repay frame", await gina.sponsoredDaily({ calls: [gina.pay(fresh(), SPEND)], sponsor: USDC, edit: (tx) => dropFrame(tx, 1) }), "ChargeFrameMissing");
await refused("no refund frame", await gina.sponsoredDaily({ calls: [gina.pay(fresh(), SPEND)], sponsor: USDC, edit: (tx) => dropFrame(tx, -1) }), "SettleFrameMissing");
await refused("a fee above the cap", await gina.sponsoredDaily({ calls: [gina.pay(fresh(), SPEND)], sponsor: USDC, fees: { maxFeePerGas: PAYMASTER_FEE_CAP + 1n, maxPriorityFeePerGas: 1n } }), "FeeTooHigh");
await refused("a price below the owner's, signed by the sender", await gina.sponsoredDaily({ calls: [gina.pay(fresh(), SPEND)], sponsor: { ...USDC, usdcPerEth: 1n } as Sponsor }), "PriceChanged");
{
  const signed = await tokenSpend(gina, fresh(), SPEND);
  await asOwner(paymasters.usdc, usdcPaymasterAbi, "setPrice", [PRICE * 2n]);
  await refused("the owner raises the price on a signed transaction", signed, "PriceChanged");
  await asOwner(paymasters.usdc, usdcPaymasterAbi, "setPrice", [PRICE]);
  const once = await tokenSpend(gina, fresh(), SPEND);
  await usdcMined("a spend, to replay", gina.account, once);
  // The nonce is what stops it. The sidecar words this one from ethrex's first canonical violation: see docs/upstream/prs/sidecar-issues.md.
  await refused("the mined spend, replayed byte for byte", once, /prefix gas budget exceeded/, { replay: true });
  check(/[Nn]once/.test((await simulate(once)).alt.reason ?? ""), "simulate gives the real cause next to it: the nonce");
}
await reverts("a body or a plain call collects", "NotEntryPoint", { account: fresh(), address: paymasters.usdc, abi: usdcPaymasterAbi, functionName: "collect", args: [PRICE] });
await reverts("a stranger sets the price", "NotOwner", { account: fresh(), address: paymasters.usdc, abi: usdcPaymasterAbi, functionName: "setPrice", args: [1n] });
await reverts("a stranger takes the USDC", "NotOwner", { account: fresh(), address: paymasters.usdc, abi: usdcPaymasterAbi, functionName: "withdrawUsdc", args: [fresh(), 1n] });
await reverts("a stranger takes the float", "NotOwner", { account: fresh(), address: paymasters.usdc, abi: usdcPaymasterAbi, functionName: "withdraw", args: [fresh(), 1n] });

console.log("\n11. the body cannot dodge what was already taken");
{
  const jack = await usdcAccount(100_000_000n);
  await usdcMined("the body revokes the approval", jack.account, jack.master([tokenCall("approve", paymasters.usdc, 0n)], USDC));
  check((await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [jack.account, paymasters.usdc] })) === 0n, "the approval is gone, and the gas was paid before that");

  const kate = await usdcAccount(100_000_000n);
  const friend = fresh();
  const tx = kate.master([tokenCall("transfer", friend, 60_000_000n)], USDC);
  await usdcMined("the body sends the account's USDC away", kate.account, tx);
  check((await usdcOf(friend)) === 60_000_000n, "the money left, and the gas was paid before that");

  await usdcMined("a body that burns its limit and fails", gina.account, await gina.sponsoredDaily({ calls: [{ ...gina.pay(fresh(), SPEND), execution: 8_000n, state: 0n }], sponsor: USDC }), { body: "fails" });
  await usdcMined("8 KB of ignored data, so that the calldata floor sets the cost", gina.account, await gina.sponsoredDaily({ calls: [payeeSpend(gina, fresh(), SPEND)], sponsor: USDC, edit: (tx) => stuffCharge(tx, 8_000) }));
}

console.log("\n12. an account whose last unit goes on gas still gets its refund");
{
  const luke = await usdcAccount(100_000_000n);
  const tx = await luke.sponsoredDaily({ calls: [luke.pay(fresh(), 0n)], sponsor: USDC });
  const needed = (BigInt((await simulate(tx)).maxCost) * PRICE + 10n ** 18n - 1n) / 10n ** 18n;
  const extra = (await usdcOf(luke.account)) - needed;
  await submit(luke.master([tokenCall("transfer", fresh(), extra)]));
  check((await usdcOf(luke.account)) === needed, `the account holds exactly the ${needed} the transaction can cost`);
  const { kept } = await usdcMined("collect empties the account, and settle refills it", luke.account, tx);
  check((await usdcOf(luke.account)) === needed - kept, `it got back ${needed - kept}`);
}

console.log("\n13. frames a batch undid, whose status still says success");
{
  // An EOA pays for itself, so `pay` never runs. This took 30 USDC from the float, in the first version, with every other test passing.
  const attacker = generatePrivateKey();
  const eoa = privateKeyToAccount(attacker).address;
  await waitForSuccess(await owned.sendTransaction({ to: eoa, value: parseEther("1"), ...plain }), "funding the attacker");
  await giveUsdc(eoa, 100_000_000n);
  await giveUsdc(paymasters.usdc, 50_000_000n);
  await waitForSuccess(await walletFor(attacker).writeContract({ address: usdc, abi: erc20Abi, functionName: "approve", args: [paymasters.usdc, APPROVAL], ...plain }), "approving");
  await enroll(paymasters.quota, eoa, 20_000_000n);

  const selfPaid = async (target: Address, charge: Hex, settleData: Hex, state: bigint, flags: number) =>
    lib.signTx(
      profile,
      lib.newTx({
        chainId: DEVNET.chainId,
        sender: eoa,
        nonceSeq: BigInt(await publicClient.getTransactionCount({ address: eoa })),
        fees: { maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1n },
        signatures: [lib.secp256k1Placeholder(profile)],
        frames: [
          lib.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 30_000n }),
          lib.frame(profile, "DEFAULT", { target, execution: 160_000n, state, flags, data: charge }),
          lib.frame(profile, "DEFAULT", { target, execution: 30_000n, data: "0xdeadbeef" }),
          lib.frame(profile, "DEFAULT", { target, execution: 150_000n, data: settleData }),
        ],
      }),
      attacker,
    );
  const collectData = encodeFunctionData({ abi: usdcPaymasterAbi, functionName: "collect", args: [PRICE] });
  const settleData = encodeFunctionData({ abi: quotaPaymasterAbi, functionName: "settle", args: [CHARGE_INDEX] });
  const chargeData = encodeFunctionData({ abi: quotaPaymasterAbi, functionName: "charge" });

  for (const [name, flags] of [["a collect inside a batch that reverts", ATOMIC_BATCH_FLAG], ["a collect with no pay frame, and no batch", 0]] as const) {
    const before = [await usdcOf(eoa), await usdcOf(paymasters.usdc)] as const;
    const { receipt, hash } = await submit(await selfPaid(paymasters.usdc, collectData, settleData, 120_000n, flags));
    const moved = [(await usdcOf(eoa)) - before[0], (await usdcOf(paymasters.usdc)) - before[1]];
    check(moved[0] === 0n && moved[1] === 0n, `${name}, then settle: nothing moved, ${hash}`);
    check(receipt.frameReceipts[3]!.status === "0x0", "settle refused");
    refusals.push({ attack: name, refusal: "PayFrameMissing, then NothingToSettle: mined, nothing moved" });
  }

  const used = (await readQuota(paymasters.quota, eoa)).used;
  await submit(await selfPaid(paymasters.quota, chargeData, settleData, 0n, ATOMIC_BATCH_FLAG));
  check((await readQuota(paymasters.quota, eoa)).used === used, "a charge undone by a batch, then settle: the quota did not move");
  refusals.push({ attack: "a batch that undoes a charge, then settle, to reset a quota", refusal: "PayFrameMissing, then NothingToSettle: mined, nothing moved" });
}

console.log("\n14. a second collect in the body, to burn the approval, which the account refuses before the paymaster has to");
{
  const mona = await usdcAccount(100_000_000n);
  const collectFrame = lib.frame(profile, "DEFAULT", { target: paymasters.usdc, execution: 160_000n, state: 120_000n, data: encodeFunctionData({ abi: usdcPaymasterAbi, functionName: "collect", args: [PRICE] }) });
  const tx = await mona.sponsoredDaily({
    calls: [mona.pay(fresh(), SPEND)],
    sponsor: USDC,
    edit: (t) => ({ ...t, frames: [...t.frames.slice(0, 3), collectFrame, collectFrame, ...t.frames.slice(3)] }),
  });
  await refused("a stolen daily key adds two more collect frames", tx, "FrameNotAllowed");
}

mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../docs/evidence/paymaster-latest.json", import.meta.url),
  JSON.stringify(
    {
      chainId: DEVNET.chainId,
      mirror: true,
      at: new Date().toISOString(),
      paymasters,
      price: { usdcPerEth: price.usdcPerEth.toString(), label: price.label },
      canonicalRefusals: Object.fromEntries(canonicalReasons),
      predictionsChecked: tally.predictions,
      transactions: evidence,
      refusals,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\n${evidence.length} mined, ${refusals.length} attacks refused, canonical refused ${tally.canonicalRefused} of ${tally.canonicalRefused}, ${tally.predictions} predictions checked, ${tally.failures} failures`);
for (const [reason, count] of canonicalReasons) console.log(`  canonical, ${count}x: ${reason.slice(0, 140)}`);
if (tally.failures) process.exit(1);
