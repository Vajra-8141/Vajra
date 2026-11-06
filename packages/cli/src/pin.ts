/** Prints the blocked escape: see `pinExperiment`. */
import { formatEther } from "viem";
import { pinExperiment } from "./mempool-lab.ts";

const outcome = await pinExperiment(console.log);
if ("inconclusive" in outcome) {
  console.log("\nINCONCLUSIVE: the thief's transaction was not admitted, so nothing held the slot and this tests nothing");
  process.exit(2);
}
if (outcome.result.lanes[0]!.verdict === "admitted") {
  console.log("\nRESULT: the canonical mempool admitted the escape despite a pending thief transaction");
  process.exit(0);
}
console.log(`harbor balance ${formatEther(outcome.harborBalance)} ETH, frozen ${outcome.frozen}`);
console.log("\nRESULT: the canonical mempool refused the escape while the thief held the slot; the alt mempool carried it");
