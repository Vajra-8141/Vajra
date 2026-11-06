// Bundles the wallet into dist/. The icons are drawn here, so that the repo holds no binary files.
//
//   node build.mjs          the real wallet. Fails if src/engine.ts is missing, and fails if the fake reached the bundle.
//   node build.mjs --fake   a screenshot build on src/dev/fake-engine.ts, written to dist-fake/ so it can never be served as dist/.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

const fake = process.argv.includes("--fake");
const root = new URL(".", import.meta.url).pathname;
const dist = `${root}${fake ? "dist-fake" : "dist"}/`;
const FAKE_MARK = "FAKE_ENGINE_DO_NOT_SHIP";

if (!fake && !existsSync(`${root}src/engine.ts`)) {
  console.error("\nbuild failed: apps/wallet/src/engine.ts is missing.\nThe wallet will not build without the real engine. For screenshots only, use: node build.mjs --fake\n");
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(`${root}public/`, dist, { recursive: true });
cpSync(new URL("../../packages/shared/ui/tokens.css", import.meta.url).pathname, `${dist}tokens.css`);
cpSync(new URL("../../packages/shared/ui/fonts/", import.meta.url).pathname, `${dist}fonts/`, { recursive: true });
await build({
  entryPoints: { app: "src/main.tsx", sw: "src/sw.ts" },
  bundle: true,
  format: "iife",
  target: "es2022",
  outdir: dist,
  absWorkingDir: root,
  jsx: "automatic",
  minify: true,
  logLevel: "warning",
  define: { __FAKE__: String(fake), "process.env.NODE_ENV": '"production"', global: "globalThis" },
});

if (!fake && readFileSync(`${dist}app.js`, "utf8").includes(FAKE_MARK)) {
  rmSync(dist, { recursive: true, force: true });
  console.error("\nbuild failed: the fake engine reached a production bundle. dist/ was deleted.\n");
  process.exit(1);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
};

/** An ink square with a diamond in the hash key's colour, inside the safe zone of a maskable icon. */
function icon(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inside = Math.abs(x - size / 2) + Math.abs(y - size / 2) < size * 0.3;
      row.set(inside ? [0x8f, 0xa8, 0xff] : [0x0a, 0x0c, 0x1b], 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [180, 192, 512]) writeFileSync(`${dist}icon-${size}.png`, icon(size));
console.log(`built ${dist}${fake ? " (FAKE engine, screenshots only)" : ""}`);
