// Draws the page's security-paper line work, the way a banknote's is: a few families of phase-shifted curves. Run once; the output is committed.
import { writeFileSync } from "node:fs";

const f = (n) => n.toFixed(1);

function band(width, height, lines, stroke) {
  const paths = [];
  for (let i = 0; i < lines; i++) {
    const phase = (i / lines) * Math.PI * 2;
    let d = "";
    for (let x = 0; x <= width; x += 6) {
      const t = (x / width) * Math.PI * 2;
      const y = height / 2 + Math.sin(t * 3 + phase) * height * 0.28 + Math.sin(t * 7 - phase * 2) * height * 0.16;
      d += `${x === 0 ? "M" : "L"}${f(x)} ${f(y)}`;
    }
    paths.push(`<path d="${d}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><g fill="none" stroke="${stroke}" stroke-width=".6">${paths.join("")}</g></svg>\n`;
}

function rosette(size, lines, stroke) {
  const c = size / 2;
  const paths = [];
  for (let i = 0; i < lines; i++) {
    const turn = (i / lines) * Math.PI * 2;
    let d = "";
    for (let s = 0; s <= 360; s += 3) {
      const a = (s * Math.PI) / 180;
      const r = c * (0.62 + 0.3 * Math.cos(a * 6 + turn * 3) * Math.cos(a * 2 - turn));
      d += `${s === 0 ? "M" : "L"}${f(c + r * Math.cos(a + turn / 6))} ${f(c + r * Math.sin(a + turn / 6))}`;
    }
    paths.push(`<path d="${d}Z"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><g fill="none" stroke="${stroke}" stroke-width=".5">${paths.join("")}</g></svg>\n`;
}

const out = (name) => new URL(`../public/${name}`, import.meta.url);
writeFileSync(out("guilloche-band.svg"), band(1200, 150, 26, "#2f7a6b"));
writeFileSync(out("guilloche-rosette.svg"), rosette(420, 22, "#4b27c6"));
