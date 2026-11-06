/**
 * The upstream finding, as one experiment: one proof transaction, byte for byte, offered to the sidecar as deployed and to the
 * sidecar with docs/upstream/sidecar-budget-010.patch. Both sit on the same chain, at the same commit. Run `make unpatched` first.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { toWire } from "@forshtat/hegota-support/rpc";
import { DEVNET, RpcError, accountState, encodeTx, isLocalStack, opsV2, recoveryTx, refusalNameV2, rpc, sendCanonical } from "@vajra/core";
import { loadOrCreateKey } from "@vajra/core/node";
import { keyPath } from "./deploy.ts";
import { proveRecovery, randomFieldElement, recoveryCommitment, stopProver } from "./proving.ts";
import { check, master, mined, newAccount, newSigner, tally } from "./zk-run.ts";

if (!isLocalStack) throw new Error("this compares two local sidecars: run it with VAJRA_STACK=local");

const UNPATCHED = "http://127.0.0.1:14338/rpc/";
const deployer = loadOrCreateKey(keyPath("deployer.key"));

await rpc(UNPATCHED, "eth_chainId").catch(() => {
  throw new Error("the unpatched sidecar is not up: run `make unpatched`");
});

const signer = newSigner();
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
const account = await newAccount(deployer, signer, fresh(), fresh(), keccak256(toHex("compare")));
const { epochSalt } = await accountState(account);
const secret = randomFieldElement();
await mined("set recovery", master(signer, account, epochSalt, [opsV2.setRecovery(await recoveryCommitment(secret), 20n)]));

const next = newSigner();
const proved = await proveRecovery({ secret, newRoot: next.root, account, epochSalt, chainId: DEVNET.chainId });
const tx = recoveryTx({ account, newRoot: next.root, nullifier: proved.nullifier, proof: proved.proof });
const bytes = keccak256(encodeTx(tx));
console.log(`\none recovery transaction, keccak of its bytes ${bytes}, from an account with a stake\n`);

const refusalOf = (send: Promise<unknown>) =>
  send.then(
    () => null,
    (error: Error) => (error instanceof RpcError ? refusalNameV2(error.message) : error.message),
  );

const unpatched = await refusalOf(rpc(UNPATCHED, "eth_sendFrameTransaction", [toWire(tx)]));
check(unpatched !== null, `sidecar as deployed:  ${unpatched === null ? "ADMITTED" : `REFUSED ${unpatched}`}`);
const canonical = await refusalOf(sendCanonical(tx));
check(canonical !== null, `canonical mempool:    ${canonical === null ? "ADMITTED" : `REFUSED ${canonical}`}`);
const { hash, receipt } = await mined("sidecar with the patch", tx);

mkdirSync(new URL("../../../docs/evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../docs/evidence/compare-latest.json", import.meta.url),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      stack: "local mirror: ethrex 9aa3645, two sidecars at 2e22ff0, one with sidecar-budget-010.patch",
      chainId: DEVNET.chainId,
      bytes,
      unpatched: { refused: unpatched },
      canonical: { refused: canonical },
      patched: { hash, block: Number(BigInt(receipt.blockNumber)), verifyGas: Number(BigInt(receipt.frameReceipts[0]!.gasUsed)) },
      failures: tally.failures,
    },
    null,
    1,
  ) + "\n",
);
await stopProver();
process.exit(tally.failures ? 1 : 0);
