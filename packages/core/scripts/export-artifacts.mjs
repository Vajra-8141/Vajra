// Copies the compiled contracts into the package, so the client runs without Foundry.
import { readFileSync, writeFileSync } from "node:fs";

const contracts = ["VajraAccount", "VajraFactory"];
for (const name of contracts) {
  const url = new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url);
  const { abi, bytecode } = JSON.parse(readFileSync(url, "utf8"));
  const out = new URL(`../src/artifacts/${name}.json`, import.meta.url);
  writeFileSync(out, JSON.stringify({ abi, bytecode: bytecode.object }) + "\n");
  console.log(`${name}: ${(bytecode.object.length - 2) / 2} bytes of creation code`);
}
