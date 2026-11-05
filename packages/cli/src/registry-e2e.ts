/**
 * The leaf registry, end to end, on the live Arkiv testnet and the live devnet. Two copies of one key, which is what restoring a
 * backup makes: A is the original, B is a copy whose counter stopped earlier.
 *
 * This is the failure one-time keys cannot survive. Everything here happens with real entities and real transactions.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Address, type Hex, createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  MasterSigner,
  WOTS_W16,
  accountState,
  createAccount,
  deployments,
  framesSucceeded,
  harborCommitment,
  ops,
  publicClient,
  signMasterTx,
  sleep,
  submit,
  type SignerState,
  type SignerStore,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { ExpirationTime, LeafRegistry, LeafRegistryWriter, LeafUseSchema, arkivChain, firstFreeLeaf, leafState } from "@vajra/core/registry";
import { keyPath } from "./deploy.ts";

const accessKey = process.env.ARKIV;
const raw = process.env.DEV_WALLET_PRIVATE_KEY;
if (!accessKey || !raw) throw new Error("ARKIV and DEV_WALLET_PRIVATE_KEY must be set in .env");
const privateKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const memory = (): SignerStore & { state: SignerState | undefined } => ({
  state: undefined,
  load() {
    return this.state;
  },
  save(state) {
    this.state = state;
  },
});

const chain = arkivChain(accessKey);
const rabdiPublic = createPublicClient({ chain, transport: http() });
const writer = privateKeyToAccount(privateKey).address;
const before = await rabdiPublic.getBalance({ address: writer });
console.log(`writer ${writer}, ${formatEther(before)} tGLM`);
if (before === 0n) throw new Error(`the writer has no tGLM: fund ${writer} at https://hub.arkiv.network/faucet`);

const seed = new Uint8Array(randomBytes(32));
const storeA = memory();
const storeB = memory();
const A = new MasterSigner(WOTS_W16, storeA, () => seed);
const B = new MasterSigner(WOTS_W16, storeB, () => seed);
const root = A.root;

const holderA = keccak256(toHex("copy A"));
const holderB = keccak256(toHex("copy B"));
const registryA = new LeafRegistryWriter({ accessKey, privateKey, holder: holderA, writers: [] });
const registryB = new LeafRegistryWriter({ accessKey, privateKey, holder: holderB, writers: [] });

const key = loadOrCreateKey(keyPath("deployer.key"));
const { w16, genesis } = deployments();
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const salt = keccak256(toHex(`arkiv ${Date.now()}`));
console.log("creating an account under that key");
const account = await createAccount(
  key,
  w16.factory,
  {
    dailyKey: privateKeyToAccount(generatePrivateKey()).address,
    wotsRoot: root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(harbor, salt),
    queueDelay: 3600n,
    coolingPeriod: 0n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("0.0001")],
    coolingAllowances: [parseEther("0.0001")],
  },
  parseEther("0.004"),
);
console.log(`account ${account}, key tree ${root}\n`);

const evidence: Record<string, unknown>[] = [];
const see = async (registry: LeafRegistry) => {
  const snapshot = await registry.snapshot(root);
  if (!snapshot) throw new Error("Arkiv did not answer");
  return snapshot;
};

async function land(signer: MasterSigner, registry: LeafRegistryWriter, leaf: number, name: string, call: ReturnType<typeof ops.freeze>) {
  const signed = signMasterTx({ signer, account, epochSalt: genesis, calls: [call], leaf, maxHashes: 660 });
  const { hash, receipt } = await submit(signed.tx, { log: (line) => console.log(`    ${line}`) });
  check(framesSucceeded(receipt), `${name}: leaf ${leaf}, mined ${hash}`);
  const entity = await registry.recordUse({ root, leaf, account, digest: signed.digest, signature: signer.sign(leaf, signed.digest), txHash: hash, op: name });
  evidence.push({ step: name, leaf, hash, entity });
  return hash;
}

console.log("1. a reservation is seen by the other copy before anything is signed");
{
  const entity = await registryA.reserve(root, 0, account);
  const seen = await see(registryB);
  check(leafState(seen, 0, holderB) === "reserved", `B sees leaf 0 reserved: ${entity}`);
  check(leafState(seen, 0, holderA) === "free", "A is not stopped by its own reservation");
  check(firstFreeLeaf(seen, 0, holderB) === 1, "B would move on to leaf 1");
  evidence.push({ step: "reservation", leaf: 0, entity });
}
await land(A, registryA, 0, "freeze", ops.freeze());

console.log("\n2. the gap the chain cannot see: a signature that was revealed and never mined");
const held = signMasterTx({ signer: A, account, epochSalt: genesis, calls: [ops.freeze()], leaf: 1, maxHashes: 660 });
{
  const entity = await registryA.recordUse({ root, leaf: 1, account, digest: held.digest, signature: A.sign(1, held.digest), op: "freeze, never broadcast" });
  evidence.push({ step: "revealed, not mined", leaf: 1, entity });
  console.log(`  A signed leaf 1, kept the transaction, and published the signature: ${entity}`);
}
check(B.nextLeaf() === 0, "B is stale: its own counter says leaf 0 is next");
{
  const seen = await see(registryB);
  check(leafState(seen, 0, holderB) === "used", "B reads leaf 0 as used, and the signature verified");
  check(leafState(seen, 1, holderB) === "used", "B reads leaf 1 as used, which no chain knows about");
  const next = firstFreeLeaf(seen, B.nextLeaf(), holderB);
  check(next === 2, `B moves past both, to leaf ${next}`);
  await land(B, registryB, next!, "unfreeze", ops.unfreeze());
  check(storeB.state!.revealed[0] === undefined && storeB.state!.revealed[1] === undefined, "B never revealed leaf 0 or leaf 1");
}
{
  const { hash, receipt } = await submit(held.tx, { log: (line) => console.log(`    ${line}`) });
  check(framesSucceeded(receipt), `A's held transaction still mines on leaf 1, so the chain never knew it was spent: ${hash}`);
  evidence.push({ step: "held transaction, mined last", leaf: 1, hash });
}

console.log("\n3. a signer reads only what can change its decision");
{
  const stale = await see(registryB);
  const current = await registryB.snapshot(root, { from: 3 });
  check(stale.uses.length === 3 && current?.uses.length === 0, `a copy that is up to date reads ${current?.uses.length} records; a stale one reads ${stale.uses.length}`);
}

console.log("\n4. a stranger cannot use the registry to block anyone");
{
  const stranger = generatePrivateKey();
  const pay = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(privateKey) });
  const funded = await pay.sendTransaction({ to: privateKeyToAccount(stranger).address, value: before / 200n });
  await rabdiPublic.waitForTransactionReceipt({ hash: funded });
  const thief = new LeafRegistryWriter({ accessKey, privateKey: stranger, holder: keccak256(toHex("thief")), writers: [] });
  const leaf = 3;
  const forged = await thief.recordUse({ root, leaf, account, digest: keccak256(toHex("nothing")), signature: `0x03${"ab".repeat(2336)}`, op: "escape" });
  const reserved = await thief.reserve(root, leaf, account);
  const seen = await see(registryB);
  check(seen.rejected === 1, `the forged usage record is rejected: ${forged}`);
  check(seen.ignored === 1, `the stranger's reservation counts for nothing: ${reserved}`);
  check(leafState(seen, leaf, holderB) === "free", "leaf 3 is still free, so neither blocks an escape");
  evidence.push({ step: "forged use", leaf, entity: forged }, { step: "forged reservation", leaf, entity: reserved });
}

console.log("\n5. a reservation expires on its own");
{
  const entity = await registryA.reserve(root, 3, account, ExpirationTime.fromSeconds(20));
  check(leafState(await see(registryB), 3, holderB) === "reserved", `reserved for 20 seconds: ${entity}`);
  await sleep(26_000);
  check(leafState(await see(registryB), 3, holderB) === "free", "gone, with nobody cleaning up");
}

console.log("\n6. any wallet can check, with no key and no account with us");
{
  const reader = new LeafRegistry({ accessKey: "", writers: [] });
  const open = await reader.snapshot(root, { patience: 45_000 });
  // The public budget is shared and can run out. That is not this code failing, so it is reported rather than counted.
  if (open) check(open.uses.length === 3, `the keyless endpoint returned ${open.uses.length} verified uses`);
  else console.log(`  note the keyless endpoint would not answer right now: ${reader.lastFailure}`);
  const anyone = await new LeafRegistry({ accessKey, writers: [] }).snapshot(root);
  check(anyone?.uses.length === 3, "a reader that trusts no writer verified all 3 uses from the signatures alone");
}

console.log("\n7. Arkiv going away does not stop the way out");
{
  const down = await new LeafRegistry({ accessKey, writers: [], rpcUrl: "http://127.0.0.1:9" }).snapshot(root);
  check(down === null, "an unreachable registry gives no answer, and no answer is not a refusal");
  const { receipt } = await submit(signMasterTx({ signer: B, account, epochSalt: genesis, calls: [ops.unfreeze()], leaf: 3, maxHashes: 660 }).tx, { log: () => {} });
  check(framesSucceeded(receipt) && !(await accountState(account)).frozen, "the account unfroze with no registry");
  const escape = await submit(signMasterTx({ signer: B, account, epochSalt: genesis, calls: [ops.escape(harbor, salt)], leaf: 4, maxHashes: 660 }).tx, { log: () => {} });
  check(framesSucceeded(escape.receipt) && (await publicClient.getBalance({ address: harbor })) > 0n, `escape mined: ${escape.hash}`);
}

const after = await rabdiPublic.getBalance({ address: writer });
const spent = before - after;
console.log(`\nthe run cost ${formatEther(spent)} tGLM`);
mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../docs/evidence/arkiv-latest.json", import.meta.url),
  JSON.stringify({ arkivChain: chain.id, devnet: DEVNET.chainId, at: new Date().toISOString(), writer, root, account: account as Address, schema: LeafUseSchema.name, tGLMSpent: formatEther(spent), entries: evidence }, null, 1) + "\n",
);
console.log(`${failures} failures`);
process.exit(failures ? 1 : 0);
