/**
 * A stealth payment, end to end, on the live devnet: ML-KEM announcement, recipient scan, and a spend that needs a hash
 * signature and a co-signature, with gas paid by the paymaster. Then the two attacks the second signature exists to
 * stop. The account never holds ETH. Exits non-zero if anything behaves differently from the claim.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Address, type Hex, bytesToHex, encodeFunctionData, hexToBytes, parseAbi, parseAbiItem } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  LEGACY_GAS_PRICE,
  MasterSigner,
  RpcError,
  STEALTH_SCHEME_ID,
  WOTS_W16,
  coSignTx,
  createAccount,
  createPayment,
  decodeMeta,
  deployments,
  framesSucceeded,

  masterDigest,
  memoryStore,
  openAnnouncement,
  predictAccount,
  publicClient,
  refusalName,
  sendAlt,
  sigHash,
  signStealthSpend,
  simulate,
  stealthCoSigner,
  stealthConfig,
  stealthKeygen,
  stealthSecretKey,
  stealthTx,
  stealthWotsSeed,
  submit,
  type Call,
  type FrameTx,
  waitForSuccess,
  walletFor,
  withMasterSignature,
  signMasterTx,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
const announcerAbi = parseAbi(["function announce(uint256,address,bytes,bytes)"]);
const registryAbi = parseAbi(["function registerKeys(uint256,bytes)", "function stealthMetaAddressOf(address,uint256) view returns (bytes)"]);
const announcement = parseAbiItem("event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)");

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

async function refused(attack: string, tx: FrameTx, expected: string | RegExp) {
  try {
    check(false, `${attack}: ADMITTED ${await sendAlt(tx)}`);
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    const name = refusalName(error.message);
    check(typeof expected === "string" ? name === expected : expected.test(name), `${attack}: ${name}`);
  }
}

const sender = loadOrCreateKey(keyPath("deployer.key"));
const senderAddress = privateKeyToAccount(sender).address;
const { w16, genesis, paymaster, announcer, registry } = deployments();
const usdc = DEVNET.usdc;
const balanceOf = (who: Address) => publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [who] });
const write = (key: Hex, address: Address, abi: never, functionName: string, args: unknown[], gas = 3_000_000n) =>
  walletFor(key).writeContract({ address, abi, functionName, args, gas, gasPrice: LEGACY_GAS_PRICE, type: "legacy", chain: undefined } as never);

const AMOUNT = 25_000_000n;
if ((await balanceOf(senderAddress)) < AMOUNT) {
  const published = loadOrCreateKey(keyPath("devnet-deployer.key"));
  console.log("topping up devnet USDC from the devnet's published deployer key");
  await waitForSuccess(await write(published, usdc, erc20 as never, "transfer", [senderAddress, 1_000_000_000n], 400_000n), "funding USDC");
}

console.log("\n1. the recipient publishes a meta-address through stock ERC-6538");
const recipient = stealthKeygen(new Uint8Array(randomBytes(128)));
const registrant = sender;
await waitForSuccess(await write(registrant, registry, registryAbi as never, "registerKeys", [BigInt(STEALTH_SCHEME_ID), bytesToHex(recipient.meta)], 12_000_000n), "registering keys");
const published = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: "stealthMetaAddressOf", args: [privateKeyToAccount(registrant).address, BigInt(STEALTH_SCHEME_ID)] });
check(published === bytesToHex(recipient.meta), `the registry holds the ${recipient.meta.length}-byte meta-address`);

console.log("\n2. the sender pays, knowing only the published meta-address");
const meta = decodeMeta(hexToBytes(published));
const payment = createPayment(meta);
const senderCoSigner = stealthCoSigner(meta.spendingPk, payment.ss);
const senderSigner = new MasterSigner(WOTS_W16, memoryStore(), () => stealthWotsSeed(payment.ss));
const config = stealthConfig(senderSigner.root, senderCoSigner, genesis);
const account = await predictAccount(w16.factory, config);
console.log(`  stealth account ${account}`);
await createAccount(sender, w16.factory, config, 0n);
await waitForSuccess(await write(sender, usdc, erc20 as never, "transfer", [account, AMOUNT], 400_000n), "paying the stealth account");
const announceHash = await write(sender, announcer, announcerAbi as never, "announce", [BigInt(STEALTH_SCHEME_ID), account, bytesToHex(payment.ephemeral), bytesToHex(new Uint8Array([payment.viewTag]))], 2_000_000n);
const { blockNumber } = await waitForSuccess(announceHash, "announcing");
check((await balanceOf(account)) === AMOUNT, "the stealth account holds 25 USDC");
check((await publicClient.getBalance({ address: account })) === 0n, "and no ETH");

console.log("\n3. the recipient finds it, from the chain alone");
const logs = await publicClient.getLogs({ address: announcer, event: announcement, args: { schemeId: BigInt(STEALTH_SCHEME_ID) }, fromBlock: blockNumber, toBlock: blockNumber });
let found: { ss: Uint8Array; account: Address; signer: MasterSigner } | undefined;
for (const log of logs) {
  const ss = openAnnouncement(recipient, hexToBytes(log.args.ephemeralPubKey!), hexToBytes(log.args.metadata!));
  if (!ss) continue;
  const signer = new MasterSigner(WOTS_W16, memoryStore(), () => stealthWotsSeed(ss));
  const derived = await predictAccount(w16.factory, stealthConfig(signer.root, stealthCoSigner(recipient.spendingPk, ss), genesis));
  if (derived === log.args.stealthAddress) found = { ss, account: derived, signer };
}
check(found?.account === account, "the scan matched the announcement to this recipient, by address");
if (!found) process.exit(1);

const coSignerKey = bytesToHex(stealthSecretKey(recipient.spendingSk, found.ss));
const coSigner = privateKeyToAccount(coSignerKey).address;
check(coSigner === senderCoSigner, "the recipient's derived key controls the co-signer the sender computed");

const payee = privateKeyToAccount(generatePrivateKey()).address;
const transfer = (to: Address, amount: bigint): Call => ({
  target: usdc,
  data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] }),
  execution: 300_000n,
  state: 300_000n,
});

console.log("\n4. who cannot spend it");
{
  // The sender holds the whole WOTS seed. Its own signature in the co-signer slot is what it can actually produce.
  const greedy = new MasterSigner(WOTS_W16, memoryStore(), () => stealthWotsSeed(payment.ss));
  const thief = generatePrivateKey();
  const tx = stealthTx({ account, leaf: 0, paymaster, coSigner: privateKeyToAccount(thief).address, calls: [transfer(senderAddress, AMOUNT)] });
  const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: genesis, account, nonceKey: 0n, sigHash: sigHash(tx) });
  const attempt = await coSignTx(withMasterSignature(tx, greedy.sign(0, digest)), thief);
  await refused("the sender, holding the full WOTS seed, takes the money back", attempt, "CoSignerRequired");
  // The same theft on a keyed nonce, the master key's usual path, where no co-signature is even asked for.
  const keyed = signMasterTx({ signer: greedy, account, epochSalt: genesis, calls: [transfer(senderAddress, AMOUNT)], maxHashes: 660 });
  await refused("the sender takes the money back on a keyed nonce", keyed.tx, "CoSignerRequired");
}
{
  // A quantum attacker can produce the ECDSA half from the public key. It cannot produce the hash half without the seed.
  const stranger = new MasterSigner(WOTS_W16, memoryStore(), () => new Uint8Array(randomBytes(32)));
  const tx = stealthTx({ account, leaf: 0, paymaster, coSigner, calls: [transfer(senderAddress, AMOUNT)] });
  const digest = masterDigest({ chainId: DEVNET.chainId, epochSalt: genesis, account, nonceKey: 0n, sigHash: sigHash(tx) });
  const attempt = await coSignTx(withMasterSignature(tx, stranger.sign(0, digest)), coSignerKey);
  await refused("an attacker with the ECDSA key but not the WOTS seed", attempt, "BadMasterSignature");
}

console.log("\n5. the recipient spends, with no ETH anywhere");
const before = await publicClient.getBalance({ address: paymaster });
const { tx, hashes } = await signStealthSpend({ signer: found.signer, coSignerKey, coSigner, account, epochSalt: genesis, paymaster, calls: [transfer(payee, 10_000_000n)] });
// Simulating reveals nothing new: this exact transaction is about to be broadcast.
const verdict = await simulate(tx);
console.log(`  canonical mempool's view of this spend: ${verdict.canonicalMempoolViolation ?? "valid"}`);
const { hash, receipt, attempts } = await submit(tx, { log: (l) => console.log(`    ${l}`) });
const frames = receipt.frameReceipts.map((f) => Number(BigInt(f.gasUsed)));
check(framesSucceeded(receipt), `mined ${hash} block ${Number(receipt.blockNumber)}, ${hashes} hashes, frames ${frames.join(" / ")} gas`);
check((await balanceOf(payee)) === 10_000_000n, "the payee received 10 USDC");
check((await balanceOf(account)) === AMOUNT - 10_000_000n, "15 USDC remain");
check((await publicClient.getBalance({ address: account })) === 0n, "the account still holds no ETH");
const after = await publicClient.getBalance({ address: paymaster });
check(after < before, `the paymaster paid ${before - after} wei`);

console.log("\n6. the same leaf again");
{
  const replay = await sendAlt(tx).then(
    (h) => `ADMITTED ${h}`,
    (e: Error) => e.message,
  );
  check(/nonce/i.test(replay), `replaying the spend: ${replay.slice(0, 80)}`);
}

mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../docs/evidence/stealth-latest.json", import.meta.url),
  JSON.stringify({ chainId: DEVNET.chainId, at: new Date().toISOString(), account, announceTx: announceHash, spendTx: hash, block: Number(receipt.blockNumber), hashes, frameGas: frames, attempts, paymaster, canonicalVerdict: verdict.canonicalMempoolViolation ?? "valid" }, null, 1) + "\n",
);
console.log(`\n${failures} failures`);
if (failures) process.exit(1);
