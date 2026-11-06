// Bundles the extension into dist/, which is what you load unpacked. A browser has no environment, so the network is chosen here, as the
// dashboard's is: VAJRA_STACK=local VAJRA_LANE=2 builds for that mirror, and no VAJRA_STACK builds for the public devnet.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const dist = `${here}dist/`;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(`${here}public/`, dist, { recursive: true });
cpSync(`${here}../../packages/shared/ui/`, dist, { recursive: true });

const stack = JSON.stringify(process.env.VAJRA_STACK ?? "");
const lane = JSON.stringify(process.env.VAJRA_LANE ?? "0");
await build({
  entryPoints: { background: "src/background.ts", inpage: "src/inpage.ts", relay: "src/relay.ts", popup: "src/popup.ts", approve: "src/approve.ts", move: "src/move.ts" },
  bundle: true,
  format: "iife",
  target: "es2022",
  outdir: dist,
  absWorkingDir: here,
  define: {
    "process.env.NEXT_PUBLIC_VAJRA_STACK": stack,
    "process.env.VAJRA_STACK": stack,
    "process.env.NEXT_PUBLIC_VAJRA_LANE": lane,
    "process.env.VAJRA_LANE": lane,
  },
});
console.log(`built ${dist} for ${process.env.VAJRA_STACK === "local" ? `the mirror, lane ${process.env.VAJRA_LANE ?? 0}` : "the public devnet"}`);
