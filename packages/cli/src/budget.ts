/**
 * Shows the alt mempool's validation cap on a staked sender, with nothing of ours involved: an EOA self-relay whose
 * VERIFY frame declares a limit over 100,000. `.vajra/probe.key` must hold a key with a stake in the registry.
 */
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as tx from "@forshtat/hegota-support/tx";
import { DEVNET, RpcError, loadOrCreateKey, profile, publicClient, sendAlt } from "@vajra/core";
import { keyPath } from "./deploy.ts";

const abi = [
  { type: "function", name: "getDepositInfo", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "uint64" }] },
] as const;

const key = loadOrCreateKey(keyPath("probe.key"));
const sender = privateKeyToAccount(key).address;
const { data } = await publicClient.call({ to: DEVNET.stakingRegistry, data: encodeFunctionData({ abi, functionName: "getDepositInfo", args: [sender] }) });
const [stake, delay, withdrawTime] = decodeFunctionResult({ abi, functionName: "getDepositInfo", data: data! });
console.log(`sender ${sender}: stake ${stake} wei, unstake delay ${delay}s, withdrawTime ${withdrawTime}`);
if (stake === 0n) {
  console.log("not staked, so this shows nothing about staked entities");
  process.exit(2);
}

const nonce = BigInt(await publicClient.getTransactionCount({ address: sender }));
for (const limit of [400_000n, 900_000n]) {
  const signed = await tx.signTx(
    profile,
    tx.newTx({
      chainId: DEVNET.chainId,
      sender,
      nonceSeq: nonce,
      fees: { maxFeePerGas: 2_000_000_000n },
      signatures: [tx.secp256k1Placeholder(profile)],
      frames: [
        tx.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: limit }),
        tx.frame(profile, "SENDER", { target: sender, execution: 50_000n }),
      ],
    }),
    key,
  );
  await sendAlt(signed).then(
    (hash) => console.log(`VERIFY limit ${limit}: ADMITTED ${hash}`),
    (error) => console.log(`VERIFY limit ${limit}: ${error instanceof RpcError ? error.message : error}`),
  );
}
