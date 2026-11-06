import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Address, type Hex, formatEther, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LeafRegistry } from "@vajra/core/registry";
import { ETH, RpcError, accountAbi, accountState, isLocalStack, ops, publicClient, refusalName, signDaily, submit } from "@vajra/core";
import { startBridge } from "./bridge.ts";
import { deploy } from "./deploy.ts";
import { closeDevice, createWallet, localDailyAddress, localDailyKey, recordSigned, requireWallet, runMasterOp, theDevice, walletStatus } from "./wallet.ts";

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
    if (a.startsWith("--")) flags[a.slice(2)] = list[i + 1]?.startsWith("--") ? "" : (list[++i] ?? "");
    else rest.push(a);
  }
  return { flags, rest };
}

const { flags, rest } = parse(args);
const submitDaily = async (tx: Parameters<typeof submit>[0]) => {
  const { hash, receipt } = await submit(tx, { log: console.log });
  recordSigned("daily", { gas: Number(BigInt(receipt.frameReceipts[0]!.gasUsed)), hash });
  return hash;
};
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
    console.log(`mined ${await submitDaily(tx)}`);
    break;
  }
  case "veto":
    report(await runMasterOp({ op: "veto", id: rest[0]! }, console.log));
    break;
  case "pay":
    report(await runMasterOp({ op: "pay", id: rest[0]! }, console.log));
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
  case "watch":
    await (await import("./watch.ts")).watch({ allowSoftwarePay: args.includes("--allow-software-pay") });
    break;
  case "phone":
    (await import("./phone.ts")).startPhone({ allowSoftwarePay: args.includes("--allow-software-pay"), port: Number(flags.port ?? process.env.VAJRA_PHONE_PORT ?? 3210) });
    break;
  case "backup":
    await (await import("./backup.ts")).backupCommand(flags);
    break;
  case "restore":
    await (await import("./backup.ts")).restoreCommand(flags);
    break;
  case "move":
    await (await import("./move.ts")).moveCommand(flags);
    break;
  case "backup-e2e":
  case "move-e2e":
    await import(`./${command}.ts`);
    break;
  case "thief": {
    // The demo's thief: the same daily key, sending far more than the limit to an address nobody has seen.
    const { account } = requireWallet();
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const tx = await signDaily({ key: localDailyKey(), dailyKey: localDailyAddress(), account, calls: [ops.spend(ETH, to, parseEther(rest[0] ?? "0.5"))] });
    console.log(`the thief sends ${rest[0] ?? "0.5"} ETH to ${to}\nmined ${await submitDaily(tx)}`);
    break;
  }
  case "judge":
    await import("./judge.ts");
    break;
  case "nonce-burn":
    await import("./nonce-burn.ts");
    break;
  case "paymaster-e2e":
    await import("./paymaster-e2e.ts");
    break;
  case "precompile-check":
    await import("./precompile-check.ts");
    break;
  case "explain":
    await (await import("./explain.ts")).explainCommand(rest[0] as Hex);
    break;
  case "rep-burn":
    await import("./rep-burn.ts");
    break;
  case "escape-solvency":
    await import("./escape-solvency.ts");
    break;
  case "proof-spam":
    await import("./proof-spam.ts");
    break;
  case "clear-sign":
    await import("./clear-sign.ts");
    break;
  case "exit-e2e":
    await import("./exit-e2e.ts");
    break;
  case "exit-setup":
    await (await import("./exit.ts")).exitSetup({ reserve: flags.reserve ?? "0.01" });
    break;
  case "exit":
    await (await import("./exit.ts")).exitEscape();
    break;
  case "nominee-setup":
    await (await import("./nominee.ts")).nomineeSetup({ out: flags.out, margin: flags.margin, maxFee: flags["max-fee"], tokens: flags.tokens });
    break;
  case "nominee-check":
    await (await import("./nominee.ts")).nomineeCheck(flags.rescue ?? rest[0] ?? (await import("./nominee.ts")).localRescuePath());
    break;
  case "nominee-watch":
    if (!flags.rescue) throw new Error("vajra nominee-watch --rescue <file> [--margin seconds] [--interval seconds]");
    await (await import("./nominee.ts")).nomineeWatch({ rescue: flags.rescue, margin: flags.margin, interval: flags.interval });
    break;
  case "nominee-revoke":
    await (await import("./nominee.ts")).nomineeRevoke();
    break;
  case "nominee-e2e":
    await import("./nominee-e2e.ts");
    break;
  case "pay-e2e":
    await import("./pay-e2e.ts");
    break;
  case "watch-e2e":
    await import("./watch-e2e.ts");
    break;
  case "stealth-theft":
    await import("./stealth-theft.ts");
    break;
  case "compare":
    await import("./compare.ts");
    break;
  case "measure-zk":
    await import("./measure-zk.ts");
    break;
  case "sphincs-bench":
    await import("./sphincs-bench.ts");
    break;
  case "shielded":
    await import("./shielded.ts");
    break;
  case "pool-e2e":
    await import("./pool-e2e.ts");
    break;
  case "shield":
    await (await import("./shield.ts")).shieldCommand({ account: flags.account, keyFile: flags["key-file"] });
    break;
  case "unshield":
    await (await import("./shield.ts")).unshieldCommand(rest[0] as Address, { account: flags.account, noCheck: flags["no-check"] !== undefined });
    break;
  case "claim":
    await (await import("./shield.ts")).claimCommand(rest[0] as Address, { account: flags.account, keyFile: flags["key-file"] });
    break;
  case "pool":
    await (await import("./shield.ts")).poolCommand(rest[0]);
    break;
  case "notes":
    await (await import("./shield.ts")).notesCommand({ account: flags.account });
    break;
  case "notes-restore":
    await (await import("./shield.ts")).notesRestoreCommand({ seedFile: flags["seed-file"], account: flags.account, gap: flags.gap });
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
alerts:   watch [--allow-software-pay]  (asks you on Telegram about anything queued; needs TELEGRAM_BOT_TOKEN in .env)
phone:    phone [--allow-software-pay] [--port n]  (the phone app's local service; see apps/phone)
backup:   backup --out file [--passphrase-file file]
          restore --in file [--passphrase-file file] [--check] [--advance-past-chain]
move:     move --key-file file --harbor <address> [--tokens a,b] [--limit eth] [--allowance eth] [--delay s] [--cooling s]
          (a new account, with an EOA's ETH and tokens in it, in one transaction; mirror only)
demo:     thief [eth]                    (the same daily key, sending over the limit to a fresh address)
master:   pay <id> | veto <id> | freeze | unfreeze | escape | rotate | set-daily <address>
second route: exit-setup [--reserve eth] | exit  (a sender of its own, with its own key tree and money: docs/FINDINGS.md section 12)
service:  bridge
signer:   device | device wipe          (VAJRA_SIGNER=device keeps the master key on the hardware)
registry: leaves [root]                 (what Arkiv knows about a key tree; needs no keys)
recovery: recover-setup [--delay s] [--out file] | recover-prove --secret file [--out file] | recover --proof file
          recover                        (no flags: the whole story on a fresh account, with every attack)
pool:     shield [--account a --key-file f] | unshield <recipient> [--account a] [--no-check]  (one note in, one note out)
          claim <recipient> --key-file f [--account a]  (a note whose recipient refused, paid to any address; the key pays the gas)
          pool [address]                 (what this pool hides, and what no chain can show; needs no key)
          notes [--account a]            (what this machine holds, and what the chain says of it)
          notes-restore [--seed-file f] [--account a] [--gap n]  (every note, rebuilt from the seed and the chain)
          shielded                       (the whole pool on a fresh account, with every attack)
          pool-e2e                       (notes rebuilt after the machine is gone, with every attack; the mirror only)
          compare                        (the same proof, offered to the sidecar as deployed and as patched)
          measure-zk                     (the gas rows for proofs)
          sphincs-bench                  (leanSphincs-S beside the hash key: gas, size, both mempools, every attack)
          These need the mirror: VAJRA_STACK=local.
gas:      explain <hash>                 (why a mined, pending or refused transaction went the way it did)
          paymaster-e2e                  (both paymasters, every attack; needs the mirror)
devnet:   deploy [w16|w256|stealth] | e2e | device-e2e | stealth | measure | pin | budget | arkiv
nominee:  nominee-setup [--out file] [--margin s] [--max-fee gwei] [--tokens 0x..,0x..]  (needs exit-setup)
          nominee-check [file] | nominee-watch --rescue file (holds no key) | nominee-revoke | nominee-e2e (the mirror only)
attacks:  rep-burn [fixed|rule] | escape-solvency [fixed] | proof-spam [fixed] | clear-sign | exit-e2e  (the mirror only)`);
    process.exit(1);
}

if (command !== "bridge" && command !== "phone") await closeDevice();
if (command?.startsWith("recover") || command?.startsWith("notes") || command === "pool" || command === "claim" || command === "shield" || command === "unshield") await (await import("./proving.ts")).stopProver();
