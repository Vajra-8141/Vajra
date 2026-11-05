import { type Address, formatEther, parseEther } from "viem";
import { ETH, RpcError, accountAbi, accountState, ops, publicClient, refusalName, signDaily, submit } from "@vajra/core";
import { startBridge } from "./bridge.ts";
import { deploy } from "./deploy.ts";
import { closeDevice, createWallet, localDailyAddress, localDailyKey, requireWallet, runMasterOp, theDevice, walletStatus } from "./wallet.ts";

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
  if (s.rootMatches === false) console.log("CHAIN STATE UNKNOWN: the account's root is not this signer's");
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
  case "deploy":
    await deploy(rest[0]);
    break;
  case "e2e":
  case "device-e2e":
  case "stealth":
  case "measure":
  case "pin":
  case "budget":
    await import(`./${command}.ts`);
    break;
  default:
    console.error(`usage: vajra <command>

account:  create --harbor <address> [--daily <address>] [--limit eth] [--allowance eth] [--delay s] [--cooling s] [--fund eth]
          status
daily:    spend <to> <eth>
master:   veto <id> | freeze | unfreeze | escape | rotate | set-daily <address>
service:  bridge
signer:   device | device wipe          (VAJRA_SIGNER=device keeps the master key on the hardware)
devnet:   deploy [w16|w256|stealth] | e2e | device-e2e | stealth | measure | pin | budget`);
    process.exit(1);
}

if (command !== "bridge") await closeDevice();
