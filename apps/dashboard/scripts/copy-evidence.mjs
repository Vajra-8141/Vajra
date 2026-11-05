// The proof page shows what the test runs recorded, so the evidence outlives the explorer's in-memory history.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const from = new URL("../../../docs/evidence/", import.meta.url);
const to = new URL("../public/evidence/", import.meta.url);
mkdirSync(to, { recursive: true });
for (const name of ["e2e-latest.json", "stealth-latest.json"]) {
  if (existsSync(new URL(name, from))) copyFileSync(new URL(name, from), new URL(name, to));
}
