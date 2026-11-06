/**
 * A wallet signing for the daily key on a V2 account, with EIP-712 typed data, so that it can show what it signs. The wallet here is
 * scripted: viem's `signTypedData`, which makes the same signature as `eth_signTypedData_v4`. A real MetaMask run is a separate record.
 * Every attack is really sent, and has to die with the name shown. Exits non-zero if anything differs from the claim.
 */
import { writeFileSync } from "node:fs";
import { concat, formatEther, hashTypedData, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  type FrameTx,
  accountState,
  accountV2Abi,
  createAccount,
  dailyTx,
  dailyTypedData,
  deployments,
  harborCommitment,
  isLocalStack,
  maxGas,
  ops,
  profile,
  publicClient,
  simulateFrames,
  sleep,
  takesTypedData,
  walletMessage,
  withTypedSignature,
  withWalletSignature,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { V2_STAKE } from "./wallet.ts";
import { check, evidence, mined, newSigner, refused, refusals, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this needs V2 with typed data, which only the mirror has until it is redeployed: VAJRA_STACK=local");

const started = Date.now();
const deployer = loadOrCreateKey(keyPath("deployer.key"));
const { v2, w16, genesis } = deployments();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const wallet = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const signer = newSigner();
const harbor = fresh();
const recipient = fresh();
const thief = fresh();
const account = await createAccount(
  deployer,
  v2!.factory,
  {
    dailyKey: wallet.address,
    wotsRoot: signer.root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(harbor, keccak256(toHex("harbor"))),
    queueDelay: 6n,
    coolingPeriod: 0n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("0.5")],
    coolingAllowances: [parseEther("0.5")],
    stake: V2_STAKE,
    unstakeDelay: 86_400,
  },
  parseEther("2"),
);
await accountState(account);
const nonce = async () => BigInt(await publicClient.getTransactionCount({ address: account }));
const unsigned = async (to = recipient, amount = parseEther("0.1")) => dailyTx({ account, dailyKey: wallet.address, nonce: await nonce(), calls: [ops.spend(ETH, to, amount)] });
const typedSign = async (tx: FrameTx) => withTypedSignature(tx, await wallet.signTypedData(dailyTypedData(tx) as never));

console.log("\n1. How a client tells them apart");
check(await takesTypedData(account), "a V2 account answers eip712Domain");
const v1 = await publicClient.getCode({ address: w16.implementation });
check(v1 !== undefined && !(await takesTypedData(w16.implementation)), "a V1 contract does not, so it keeps personal_sign");

console.log("\n2. What the wallet is shown");
const honest = await unsigned();
const shown = dailyTypedData(honest);
console.log(`  ${shown.primaryType}: asset ${(shown.message as { asset: string }).asset}, recipient ${(shown.message as { recipient: string }).recipient}, amount ${formatEther((shown.message as { amount: bigint }).amount)} ETH`);
console.log(`  domain ${shown.domain.name} ${shown.domain.version}, chain ${shown.domain.chainId}, account ${shown.domain.verifyingContract}`);
const signature = await wallet.signTypedData(shown as never);
const good = withTypedSignature(honest, signature);

console.log("\n3. Attacks on a signature the wallet gave");
const otherFrames = dailyTx({ account, dailyKey: wallet.address, nonce: honest.nonceSeq, calls: [ops.spend(ETH, thief, parseEther("0.1"))] }).frames;
await refused("Moved onto another recipient", { ...good, frames: otherFrames }, "SignatureNotBoundToTransaction");
const moreFrames = dailyTx({ account, dailyKey: wallet.address, nonce: honest.nonceSeq, calls: [ops.spend(ETH, recipient, parseEther("0.2"))] }).frames;
await refused("Moved onto a larger amount", { ...good, frames: moreFrames }, "SignatureNotBoundToTransaction");
await refused("Resent with another fee", { ...good, fees: { ...good.fees, maxFeePerGas: good.fees.maxFeePerGas * 2n } }, "SignatureNotBoundToTransaction");
const body = good.frames[1]!;
const dirty = `${body.data.slice(0, 10 + 64)}ff${body.data.slice(10 + 64 + 2)}` as `0x${string}`;
await refused("Resent with dirty high bits in the recipient word, to die in the SENDER frame", { ...good, frames: [good.frames[0]!, { ...body, data: dirty }] }, "SignatureNotBoundToTransaction");
await refused("Resent with trailing bytes", { ...good, frames: [good.frames[0]!, { ...body, data: concat([body.data, "0x01"]) }] }, "SignatureNotBoundToTransaction");
await refused("Resent with the body's gas cut, to die in the SENDER frame", { ...good, frames: [good.frames[0]!, { ...body, limits: { ...body.limits, execution: 1000n } }] }, "SignatureNotBoundToTransaction");
await refused("Resent with the body turned into a no-op frame", { ...good, frames: [good.frames[0]!, { ...body, mode: 0 } as never] }, "SignatureNotBoundToTransaction");
/** A real signature from the real key, over the same fields in another domain, with `msg` set to match it, so that the protocol passes it. */
const elsewhere = async (domain: object): Promise<FrameTx> => {
  const typed = { ...shown, domain: { ...shown.domain, ...domain } };
  const moved = withTypedSignature(honest, await wallet.signTypedData(typed as never));
  return { ...moved, signatures: moved.signatures.map((e) => ({ ...e, msg: hashTypedData(typed as never) })) };
};
await refused("Signed for another account", await elsewhere({ verifyingContract: fresh() }), "SignatureNotBoundToTransaction");
await refused("Signed for another chain", await elsewhere({ chainId: 1 }), "SignatureNotBoundToTransaction");
await refused("The old blind personal_sign, on a V2 account", withWalletSignature(honest, await wallet.signMessage({ message: { raw: walletMessage(honest) } })), "SignatureNotBoundToTransaction");
await refused("Typed data signed by another key", withTypedSignature(honest, await stranger.signTypedData(shown as never)), "Invalid frame transaction signature");

console.log("\n3b. What the signature does not hash directly: frame 0, and the entries");
const verify = good.frames[0]!;
const withVerify = (over: object): FrameTx => ({ ...good, frames: [{ ...verify, ...over }, body] });
const zeros = (bytes: number) => toHex(new Uint8Array(bytes));
const junk = { scheme: profile.sigSchemes.ARBITRARY!, signer: "0x", msg: "0x", signature: "0x01" } as const;
await refused("Frame 0 padded by one byte", withVerify({ data: concat([verify.data, zeros(1)]) }), "SignatureNotBoundToTransaction");
await refused("Frame 0 padded towards the cost cap", withVerify({ data: concat([verify.data, zeros(40_000)]) }), "SignatureNotBoundToTransaction");
await refused("Frame 0's limit raised towards the cost cap", withVerify({ limits: { ...verify.limits, execution: verify.limits.execution + 20_000n } }), "SignatureNotBoundToTransaction");
await refused("Frame 0's state limit raised", withVerify({ limits: { ...verify.limits, state: 100_000n } }), "SignatureNotBoundToTransaction");
await refused("A signature entry added", { ...good, signatures: [...good.signatures, junk] }, "SignatureNotBoundToTransaction");
// MAX_COST holds still here: the padding is paid for out of frame 0's limit, so only signing that limit stops it.
const traded = withVerify({ data: concat([verify.data, zeros(2_500)]), limits: { ...verify.limits, execution: verify.limits.execution - 10_000n } });
check(maxGas(traded) === maxGas(good), "the next copy has the same maximum gas as the honest transaction");
await refused("Frame 0 padded, paid for by cutting its limit, so that the cost holds still", traded, "SignatureNotBoundToTransaction");

console.log("\n4. The real thing");
const simulated = await simulateFrames(good);
check(BigInt(simulated.maxCost) === (shown.message as { maxCost: bigint }).maxCost, `the node's maximum cost is the one the wallet signed: ${simulated.maxCost}`);
await mined("a spend, signed as typed data", good);
check((await publicClient.getBalance({ address: recipient })) === parseEther("0.1"), "the recipient holds what the wallet showed");

const queued = await unsigned(thief, parseEther("0.6"));
await mined("a spend over the limit, signed as typed data, which queues", await typedSign(queued));
const id = 0n;
const item = (await publicClient.readContract({ address: account, abi: accountV2Abi as never, functionName: "queuedItem", args: [id] } as never)) as { executeAfter: bigint };
while ((await publicClient.getBlock()).timestamp <= item.executeAfter) await sleep(500);
const execute = dailyTx({ account, dailyKey: wallet.address, nonce: await nonce(), calls: [ops.executeQueued(id)] });
console.log(`  ${dailyTypedData(execute).primaryType}: id ${(dailyTypedData(execute).message as { id: bigint }).id}`);
await mined("executing it, signed as typed data", await typedSign(execute));
check((await publicClient.getBalance({ address: thief })) === parseEther("0.6"), "the matured item paid out");

console.log("\n5. A spend of nearly the whole balance, which a copy at a higher cost used to kill");
{
  const payee = fresh();
  const tight = await createAccount(
    deployer,
    v2!.factory,
    {
      dailyKey: wallet.address,
      wotsRoot: signer.root,
      epochSalt: genesis,
      harborCommitment: harborCommitment(harbor, keccak256(toHex("harbor"))),
      queueDelay: 6n,
      coolingPeriod: 0n,
      maxDailyTxCost: parseEther("0.01"),
      assets: [ETH],
      dailyLimits: [parseEther("1")],
      coolingAllowances: [parseEther("1")],
      stake: 0n,
      unstakeDelay: 0,
    },
    parseEther("0.1"),
  );
  const unsignedSpend = (amount: bigint) => dailyTx({ account: tight, dailyKey: wallet.address, nonce: 1n, calls: [ops.spend(ETH, payee, amount)] });
  // The amount is data too, so its own bytes are in the cost: one byte is 24 gwei here. 100 gwei over covers that.
  const costOf = (value: bigint) => (dailyTypedData(unsignedSpend(value)).message as { maxCost: bigint }).maxCost;
  const amount = parseEther("0.1") - costOf(parseEther("0.09")) - 100_000_000_000n;
  check(amount + costOf(amount) <= parseEther("0.1"), `the balance covers the spend and the signed cost, with ${parseEther("0.1") - amount - costOf(amount)} wei over`);
  const spendAll = await typedSign(unsignedSpend(amount));
  const front = spendAll.frames[0]!;
  await refused("The stranger's copy, padded so that the cost leaves too little for the spend", { ...spendAll, frames: [{ ...front, data: concat([front.data, zeros(20_000)]) }, spendAll.frames[1]!] }, "SignatureNotBoundToTransaction");
  await mined("the honest spend, with the balance leaving room for the signed cost and no more", spendAll);
  check((await publicClient.getBalance({ address: payee })) === amount, "the payee got all of it");
}

writeFileSync(
  new URL("../../../docs/evidence/clear-sign-latest.json", import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645 + sidecar 2e22ff0 with sidecar-budget-010.patch. A scripted wallet, not MetaMask",
      chainId: DEVNET.chainId,
      account,
      failures: tally.failures,
      mined: evidence,
      refusals,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\n${evidence.length} mined, ${refusals.length} refused, ${tally.failures} failures, ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(tally.failures ? 1 : 0);
