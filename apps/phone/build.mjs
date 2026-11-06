// Bundles the app into dist/, which `vajra phone` serves. The icons are drawn here, so that the repo holds no binary files.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

const dist = new URL("./dist/", import.meta.url).pathname;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(new URL("./public/", import.meta.url).pathname, dist, { recursive: true });
await build({ entryPoints: { app: "src/app.ts", sw: "src/sw.ts" }, bundle: true, format: "iife", target: "es2022", outdir: dist, absWorkingDir: new URL(".", import.meta.url).pathname });

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

/** A dark square with an amber diamond, inside the safe zone of a maskable icon. */
function icon(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inside = Math.abs(x - size / 2) + Math.abs(y - size / 2) < size * 0.3;
      row.set(inside ? [0xf2, 0xb6, 0x32] : [0x0c, 0x0e, 0x11], 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [192, 512]) writeFileSync(`${dist}icon-${size}.png`, icon(size));
console.log(`built ${dist}`);
