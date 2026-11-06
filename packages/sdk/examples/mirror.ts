/**
 * Every action, against the mirror. An account with no ETH asks both mempools, spends with the paymaster paying, has a large spend
 * queued, vetoes it, and looks at its own escape status.
 *
 *     make judge
 *     VAJRA_STACK=local node packages/sdk/examples/mirror.ts
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, parseAbi, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, ETH, LEGACY_GAS_PRICE, MasterSigner, WOTS_W16, createAccount, deployments, harborCommitment, isLocalStack, memoryStore, ops, queuedEvents, signSponsoredDaily, waitForSuccess, walletFor } from "@vajra/core";
import { useDeployments, vajraActions, vajraChain } from "@vajra/sdk";

if (!isLocalStack) throw new Error("run this with VAJRA_STACK=local");

// The mirror writes its addresses and its throwaway deployer key here. Neither is the public devnet's.
const local = (name: string) => new URL(`../../../.vajra-local/${name}`, import.meta.url);
useDeployments(JSON.parse(readFileSync(local("deployments.json"), "utf8")));
const deployer = readFileSync(local("deployer.key"), "utf8").trim() as `0x${string}`;

const client = createPublicClient({ chain: vajraChain, transport: http(DEVNET.execution) }).extend(vajraActions());

// An account holding nothing, on the quota paymaster.
const { w16, genesis, paymasters } = deployments();
const key = generatePrivateKey();
const dailyKey = privateKeyToAccount(key).address;
const signer = new MasterSigner(WOTS_W16, memoryStore(), () => crypto.getRandomValues(new Uint8Array(32)));
const harbor = privateKeyToAccount(generatePrivateKey()).address;
const account = await createAccount(
  deployer,
  w16.factory,
  {
    dailyKey,
    wotsRoot: signer.root,
    epochSalt: genesis,
    harborCommitment: harborCommitment(harbor, keccak256(toHex("salt"))),
    queueDelay: 3600n,
    coolingPeriod: 0n,
    maxDailyTxCost: parseEther("0.01"),
    assets: [ETH],
    dailyLimits: [parseEther("0.001")],
    coolingAllowances: [parseEther("0.001")],
  },
  parseEther("0.01"),
);
const sponsor = { kind: "quota", paymaster: paymasters!.quota } as const;
await waitForSuccess(
  await walletFor(deployer).writeContract({
    address: sponsor.paymaster,
    abi: parseAbi(["function enroll(address, uint64)"]),
    functionName: "enroll",
    args: [account, 20_000_000n],
    gas: 500_000n,
    gasPrice: LEGACY_GAS_PRICE,
    type: "legacy",
    chain: undefined,
  }),
  "enrolling",
);
console.log(`account ${account}`);

// simulate: nothing is sent.
const payee = privateKeyToAccount(generatePrivateKey()).address;
const tx = await signSponsoredDaily({ key, dailyKey, account, calls: [ops.spend(ETH, payee, parseEther("0.0005"))], sponsor });
const { canonical, alt } = await client.simulate({ tx });
console.log(`canonical: ${canonical.admitted}, ${canonical.rule}: ${canonical.fix}`);
console.log(`alt: ${alt.admitted}, not checked: ${alt.unverified.join(", ")}`);

// send, then explain what happened.
const sent = await client.send({ tx });
const told = await client.explain({ hash: sent.hash });
console.log(`mined in block ${sent.block}, ${sent.gasUsed} gas, all frames ok: ${sent.succeeded}, paid by ${told.payer}`);

// spend, over the limit, so that it queues.
const big = await client.spend({ account, key, dailyKey, to: payee, amount: parseEther("0.005"), sponsor });
const [queued] = queuedEvents(big.receipt.frameReceipts[3]!.logs as never);
console.log(`queued as item ${queued!.id}`);

// veto, with the master key.
const vetoed = await client.veto({ account, signer, id: queued!.id, sponsor });
console.log(`vetoed in block ${vetoed.block}, all frames ok: ${vetoed.succeeded}`);

console.log("escape status", await client.escapeStatus({ account }));
