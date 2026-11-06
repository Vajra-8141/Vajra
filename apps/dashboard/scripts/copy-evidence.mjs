// The proof pages link each record's raw file, so the evidence outlives the explorer's in-memory history.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const from = new URL("../../../docs/evidence/", import.meta.url);
const to = new URL("../public/evidence/", import.meta.url);
mkdirSync(to, { recursive: true });
for (const name of readdirSync(from)) {
  if (name.endsWith(".json")) copyFileSync(new URL(name, from), new URL(name, to));
}
