import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Address, type Hex, formatEther, parseEther } from "viem";
import { LeafRegistry } from "@vajra/core/registry";
import { ETH, RpcError, accountAbi, accountState, isLocalStack, ops, publicClient, refusalName, signDaily, submit } from "@vajra/core";
import { startBridge } from "./bridge.ts";
import { deploy } from "./deploy.ts";
import { closeDevice, createWallet, localDailyAddress, localDailyKey, requireWallet, runMasterOp, theDevice, walletStatus } from "./wallet.ts";

// Optional: it only holds what the leaf registry needs, and everything works without one.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname);
} catch {}

const [command, ...args] = process.argv.slice(2);

/** `--name value` flags, and everything else in order. */
function parse(list: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = list[++i] ?? "";
    else rest.push(a);
  }
  return { flags, rest };
}

const { flags, rest } = parse(args);
const report = (r: { hash: string; block: number; verifyGas: number; leaf: number; leavesLeft: number }) =>
  console.log(`mined ${r.hash}\nblock ${r.block}, VERIFY ${r.verifyGas} gas, leaf ${r.leaf}, ${r.leavesLeft} leaves left`);

/** Anyone can run this: it needs no keys, and it believes nothing it cannot verify. */
async function leaves(root: Hex) {
  const registry = new LeafRegistry({ accessKey: process.env.ARKIV ?? "", writers: [] });
  const snapshot = await registry.snapshot(root, { patience: 45_000 });
  if (!snapshot) throw new Error(`Arkiv did not answer: ${registry.lastFailure}. Without a key this read shares a small public budget: put a free key from hub.arkiv.network in ARKIV.`);
  console.log(`key tree ${root}\n${snapshot.uses.length} verified uses, ${snapshot.rejected} forged or damaged, ${snapshot.reservations.length + snapshot.ignored} live reservations`);
  for (const use of snapshot.uses.sort((a, b) => a.leaf - b.leaf)) {
    console.log(`  leaf ${use.leaf}: ${use.op}, ${new Date(use.at * 1000).toISOString()}, ${use.txHash ?? "revealed, no transaction recorded"}`);
  }
}

async function status() {
  const s = await walletStatus();
  console.log(`master signer: ${s.signer}${s.connected ? `, ${s.leavesLeft} leaves left` : ", NOT CONNECTED"}`);
  if (!s.account) return console.log("no account yet");
  const chain = await accountState(s.account);
  const balance = await publicClient.getBalance({ address: s.account });
  const rule = (await publicClient.readContract({ address: s.account, abi: accountAbi, functionName: "rule", args: [ETH] })) as readonly [boolean, bigint, bigint, bigint];
  console.log(`account ${s.account}\nbalance ${formatEther(balance)} ETH`);
  console.log(`daily limit ${formatEther(rule[1])} ETH, ${formatEther(rule[3])} used in the last 24 hours`);
  console.log(`daily key ${chain.dailyKey}\nfrozen ${chain.frozen}\nqueued items ${chain.nextItem}`);
  console.log(`leaf registry ${s.registryWriter ? `on Arkiv, writer ${s.registryWriter}` : "off: no keys in .env"}`);
  if (s.rootMatches === false) console.log("CHAIN STATE UNKNOWN: the account's root is not this signer's");
}

/**
 * These runs record to docs/evidence/, and what is there is the public devnet's. A run against the mirror must not replace it,
 * so on the mirror its record is moved to .vajra-local/evidence/, and the public file is put back.
 */
function protectEvidence() {
  if (!isLocalStack) return;
  const dir = new URL("../../../docs/evidence/", import.meta.url);
  const kept = new URL("../../../.vajra-local/evidence/", import.meta.url);
  const before = new Map(readdirSync(dir).map((name) => [name, readFileSync(new URL(name, dir))]));
  mkdirSync(kept, { recursive: true });
  process.on("exit", () => {
    for (const name of readdirSync(dir)) {
      const now = readFileSync(new URL(name, dir));
      const was = before.get(name);
      if (was?.equals(now)) continue;
      writeFileSync(new URL(name, kept), now);
      if (was) writeFileSync(new URL(name, dir), was);
      else rmSync(new URL(name, dir));
      console.log(`mirror run: recorded in .vajra-local/evidence/${name}, not in docs/evidence/`);
    }
  });
}

process.on("uncaughtException", (error) => {
  console.error(`refused: ${error instanceof RpcError ? refusalName(error.message) : error.message}`);
  process.exit(1);
});

switch (command) {
  case "create": {
    const dailyKey = (flags.daily ?? localDailyAddress()) as Address;
    if (!flags.harbor) throw new Error("--harbor <address> is required: the one place an escape can send funds");
    const wallet = await createWallet({
      dailyKey,
      harbor: flags.harbor as Address,
      dailyLimit: flags.limit ?? "0.01",
      coolingAllowance: flags.allowance ?? "0.001",
      queueDelay: Number(flags.delay ?? 86_400),
      coolingPeriod: Number(flags.cooling ?? 86_400),
      fund: flags.fund ?? "0.02",
    });
    console.log(`account ${wallet.account}\ndaily key ${dailyKey}`);
    break;
  }
  case "status":
    await status();
    break;
  case "spend": {
    const [to, amount] = rest as [Address, string];
    const { account } = requireWallet();
    const tx = await signDaily({ key: localDailyKey(), dailyKey: localDailyAddress(), account, calls: [ops.spend(ETH, to, parseEther(amount))] });
    console.log(`mined ${(await submit(tx, { log: console.log })).hash}`);
    break;
  }
  case "veto":
    report(await runMasterOp({ op: "veto", id: rest[0]! }, console.log));
    break;
  case "freeze":
  case "unfreeze":
  case "escape":
  case "rotate":
    report(await runMasterOp({ op: command }, console.log));
    break;
  case "set-daily":
    report(await runMasterOp({ op: "setDailyKey", key: rest[0] as Address }, console.log));
    break;
  case "bridge":
    startBridge();
    break;
  case "device": {
    const device = await theDevice();
    if (rest[0] === "wipe") console.log(await device.wipe());
    else console.log(await device.info());
    break;
  }
  case "leaves": {
    const root = (rest[0] ?? (await walletStatus()).root) as Hex | null;
    if (!root) throw new Error("usage: vajra leaves <root>");
    await leaves(root);
    break;
  }
  case "deploy":
    await deploy(rest[0]);
    break;
  case "arkiv":
    await import("./registry-e2e.ts");
    break;
  case "e2e":
    protectEvidence();
    await import("./e2e.ts");
    break;
  case "stealth":
    protectEvidence();
    await import("./stealth.ts");
    break;
  case "device-e2e":
    protectEvidence();
    await import("./device-e2e.ts");
    break;
  case "measure":
  case "pin":
  case "budget":
    await import(`./${command}.ts`);
    break;
  case "judge":
    await import("./judge.ts");
    break;
  case "nonce-burn":
    await import("./nonce-burn.ts");
    break;
  case "compare":
    await import("./compare.ts");
    break;
  case "measure-zk":
    await import("./measure-zk.ts");
    break;
  case "shielded":
    await import("./shielded.ts");
    break;
  case "shield":
    await (await import("./shield.ts")).shieldCommand();
    break;
  case "unshield":
    await (await import("./shield.ts")).unshieldCommand(rest[0] as Address);
    break;
  case "recover-setup": {
    const { recoverSetup } = await import("./recovery.ts");
    await recoverSetup({ delay: BigInt(flags.delay ?? 172_800), out: flags.out });
    break;
  }
  case "recover-prove": {
    const { recoverProve } = await import("./recovery.ts");
    await recoverProve({ secretFile: flags.secret, out: flags.out, account: flags.account as Address | undefined });
    break;
  }
  case "recover": {
    // With a proof this is the real thing, on your account. Without one it is the whole story on a fresh account.
    if (flags.proof) await (await import("./recovery.ts")).recover({ proofFile: flags.proof });
    else await import("./recover.ts");
    break;
  }
  default:
    console.error(`usage: vajra <command>

account:  create --harbor <address> [--daily <address>] [--limit eth] [--allowance eth] [--delay s] [--cooling s] [--fund eth]
          status
daily:    spend <to> <eth>
master:   veto <id> | freeze | unfreeze | escape | rotate | set-daily <address>
service:  bridge
signer:   device | device wipe          (VAJRA_SIGNER=device keeps the master key on the hardware)
registry: leaves [root]                 (what Arkiv knows about a key tree; needs no keys)
recovery: recover-setup [--delay s] [--out file] | recover-prove --secret file [--out file] | recover --proof file
          recover                        (no flags: the whole story on a fresh account, with every attack)
pool:     shield | unshield <recipient>  (one note in, one note out)
          shielded                       (the whole pool on a fresh account, with every attack)
          compare                        (the same proof, offered to the sidecar as deployed and as patched)
          measure-zk                     (the gas rows for proofs)
          These need the mirror: VAJRA_STACK=local.
devnet:   deploy [w16|w256|stealth] | e2e | device-e2e | stealth | measure | pin | budget | arkiv`);
    process.exit(1);
}

if (command !== "bridge") await closeDevice();
if (command?.startsWith("recover") || command === "shield" || command === "unshield") await (await import("./proving.ts")).stopProver();
