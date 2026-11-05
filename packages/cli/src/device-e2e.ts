/**
 * The hardware path, end to end, against the live devnet. The signer holds the master key, and this process plays the part
 * it plays in real use: a host that asks, and sometimes lies.
 *
 * On a real board, press BOOT whenever the screen asks. Run under `VAJRA_DEVICE=emulator:<file>` this proves the logic and
 * the protocol, and proves nothing about the hardware; the output says which it was.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { type Address, type Hex, hexToBytes, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET,
  ETH,
  WOTS_W16,
  accountState,
  createAccount,
  deployments,
  encodeTx,
  framesSucceeded,
  harborCommitment,
  masterTx,
  ops,
  predictAccount,
  prepareMasterTx,
  publicClient,
  queuedEvents,
  signDaily,
  submit,
  type Call,
  verifyMasterSignature,
  withMasterSignature,
} from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { Device, DeviceRefused } from "./device.ts";

const PROMPTS = 10;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

let device = await Device.open();
const first = await device.info();
console.log(`signer: ${first.kind}, root ${first.root}`);
if (first.kind !== "esp32") console.log("THIS IS THE EMULATOR. It tests the logic and the protocol, not the hardware.\n");

const key = loadOrCreateKey(keyPath("deployer.key"));
const { w16, genesis } = deployments();
const dailyPrivate = generatePrivateKey();
const daily = privateKeyToAccount(dailyPrivate).address;
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const outsider = privateKeyToAccount(generatePrivateKey()).address;
const salt = keccak256(toHex(`device ${Date.now()}`));

const config = {
  dailyKey: daily,
  wotsRoot: first.root,
  epochSalt: genesis,
  harborCommitment: harborCommitment(harbor, salt),
  queueDelay: 3600n,
  coolingPeriod: 0n,
  maxDailyTxCost: parseEther("0.01"),
  assets: [ETH],
  dailyLimits: [parseEther("0.0001")],
  coolingAllowances: [parseEther("0.0001")],
};

/** A person has to reach the board, so a prompt that timed out is asked again. A declined prompt burns no leaf. */
async function pressed<T>(ask: () => Promise<T>): Promise<T> {
  for (let prompt = 1; ; prompt++) {
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof DeviceRefused) || error.message !== "Declined" || prompt === PROMPTS) throw error;
      console.log("  no press in 60 seconds, asking again");
    }
  }
}

// Pairing comes first, so nothing is spent until someone is at the board.
const account = await predictAccount(w16.factory, config);
console.log(`press BOOT to pair ${account}`);
await pressed(() => device.pair(account, DEVNET.chainId, genesis));
console.log("creating an account whose master key the signer holds");
await createAccount(key, w16.factory, config, parseEther("0.015"));

const evidence: { step: string; hash: Hex; block: number; verifyGas: number; leaf: number }[] = [];

async function master(step: string, call: Call) {
  const info = await device.info();
  const { tx, digest } = prepareMasterTx({ root: info.root, leaf: info.next, params: WOTS_W16, account, epochSalt: genesis, calls: [call], maxHashes: 660 });
  console.log(`  press BOOT: ${step}`);
  const blob = await pressed(() => device.sign(encodeTx(tx)));
  check(verifyMasterSignature(WOTS_W16, hexToBytes(digest), hexToBytes(blob), hexToBytes(info.root)), "the signature verifies here, before anything is broadcast");
  const { hash, receipt } = await submit(withMasterSignature(tx, blob), { log: (l) => console.log(`    ${l}`) });
  const verifyGas = Number(BigInt(receipt.frameReceipts[0]!.gasUsed));
  check(framesSucceeded(receipt), `${step}: ${hash} block ${Number(receipt.blockNumber)}, VERIFY ${verifyGas} gas, leaf ${info.next}`);
  evidence.push({ step, hash, block: Number(receipt.blockNumber), verifyGas, leaf: info.next });
  return { hash, receipt };
}

/** The host asks for something the device must not sign. It should never reach the button. */
async function hostAsks(attack: string, raw: Hex, expected: string) {
  const before = (await device.info()).next;
  const outcome = await device.sign(raw).then(
    () => "SIGNED",
    (error: Error) => (error instanceof DeviceRefused ? error.message : `error: ${error.message}`),
  );
  const after = (await device.info()).next;
  check(outcome === expected && after === before, `${attack}: ${outcome}`);
}

console.log("\n1. the signer's signatures are accepted by the account");
await master("freeze", ops.freeze());
check((await accountState(account)).frozen, "the account is frozen");
await master("unfreeze", ops.unfreeze());

console.log("\n2. a stolen daily key queues a theft, and the signer vetoes it");
const queued = await submit(await signDaily({ key: dailyPrivate, dailyKey: daily, account, calls: [ops.spend(ETH, outsider, parseEther("0.005"))] }), {});
const [event] = queuedEvents(queued.receipt.frameReceipts[1]!.logs as { topics: Hex[]; data: Hex }[]);
await master(`veto item ${event!.id}`, ops.veto(event!.id));

console.log("\n3. a compromised host");
{
  const info = await device.info();
  const at = (call: Call, sender: Address = account) => masterTx({ account: sender, root: info.root, leaf: info.next, calls: [call] });
  await hostAsks("sign a payment straight to a thief", encodeTx(at({ target: outsider, data: "0x", value: parseEther("0.01"), execution: 60_000n, state: 200_000n })), "BadShape");
  await hostAsks("sign for another account", encodeTx(at(ops.freeze(), outsider)), "WrongAccount");
  await hostAsks("sign a call the device cannot describe", encodeTx(at({ data: "0xdeadbeef", execution: 60_000n, state: 100_000n })), "UnknownOperation");
  await hostAsks("rotate to the attacker's tree", encodeTx(at(ops.rotateRoot(keccak256(toHex("attacker"))))), "RotationRootUnknown");
  await hostAsks(
    "sign with a fee that drains the account",
    encodeTx(masterTx({ account, root: info.root, leaf: info.next, calls: [ops.freeze()], fees: { maxFeePerGas: 100_000_000_000_000n } })),
    "FeeTooHigh",
  );
  const spent = masterTx({ account, root: info.root, leaf: info.next - 1, calls: [ops.freeze()] });
  await hostAsks("sign a new message with a spent leaf", encodeTx(spent), "LeafAlreadyRevealed");
}

console.log("\n4. a rotation, and the old tree's end");
{
  const next = await device.nextRoot();
  await master("rotate to the device's next tree", ops.rotateRoot(next));
  console.log("  press BOOT: switch to the new tree");
  await pressed(() => device.rotated(next));
  const info = await device.info();
  check(info.root === next && info.next === 0 && info.tree === first.tree + 1, `the signer moved to tree ${info.tree}`);
  check((await accountState(account)).wotsRoot === next, "and the chain agrees");
  await master("the new tree signs", ops.freeze());
  await master("and unfreezes", ops.unfreeze());
}

console.log("\n5. the escape");
{
  const { receipt } = await master(`escape to ${harbor}`, ops.escape(harbor, salt));
  check(framesSucceeded(receipt), "every frame succeeded");
  check((await publicClient.getBalance({ address: harbor })) > 0n, `the harbor holds ${await publicClient.getBalance({ address: harbor })} wei`);
}

if (first.kind === "emulator") {
  console.log("\n6. nobody presses the button");
  await device.close();
  process.env.VAJRA_CONFIRM = "no";
  device = await Device.open();
  const before = await device.info();
  const { tx } = prepareMasterTx({ root: before.root, leaf: before.next, params: WOTS_W16, account, epochSalt: genesis, calls: [ops.freeze()], maxHashes: 660 });
  await hostAsks("sign with no press", encodeTx(tx), "Declined");
}

await device.close();
mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../../../docs/evidence/device-${first.kind}-latest.json`, import.meta.url),
  JSON.stringify({ chainId: DEVNET.chainId, signer: first.kind, at: new Date().toISOString(), account, transactions: evidence }, null, 1) + "\n",
);
console.log(`\n${evidence.length} transactions signed by the ${first.kind} and mined, ${failures} failures`);
process.exit(failures ? 1 : 0);
