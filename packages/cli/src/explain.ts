/** `vajra explain <hash>`. Prints what is known, and says "unknown" for what is not. */
import { type Explanation, type Verdict, explain } from "@vajra/core";
import type { Hex } from "viem";

const said = (name: string, v: Verdict) => {
  const answer = v.admitted === null ? "unknown" : v.admitted ? "admitted" : "refused";
  const lines = [`${name}: ${answer} (from ${v.source})`];
  if (v.rule) lines.push(`  rule    ${v.rule}`);
  if (v.refusal) lines.push(`  refusal ${v.refusal}`);
  if (v.reason) lines.push(`  says    ${v.reason.slice(0, 200)}`);
  if (v.fix) lines.push(`  fix     ${v.fix}`);
  if (v.unverified.length) lines.push(`  not checked: ${v.unverified.join(", ")}`);
  return lines.join("\n");
};

const gas = (n: number | null) => (n === null ? "unknown" : n.toLocaleString("en-US"));

export function render(e: Explanation): string {
  const lines = [`${e.hash}`, `state   ${e.state}${e.block !== null ? `, block ${e.block}` : ""}`];
  lines.push(`sender  ${e.sender ?? "unknown"}`, `payer   ${e.payer ?? "unknown"}`, `gas     ${e.gasUsed === null ? "unknown" : e.gasUsed.toLocaleString("en-US")}`);
  if (e.frames.length) {
    lines.push("frames");
    for (const f of e.frames) lines.push(`  ${f.index} ${f.mode.padEnd(7)} ${f.status.padEnd(8)} execution ${gas(f.gasUsed)}, state ${gas(f.stateGasUsed)}, target ${f.target}`);
  } else lines.push("frames  unknown");
  lines.push(said("canonical", e.canonical), said("alt", e.alt));
  if (e.checks) {
    lines.push("rules, as the sidecar recorded them");
    for (const c of e.checks) lines.push(`  ${c.verdict.padEnd(5)} ${c.rule}${c.entity ? ` (${c.entity}, frame ${c.frameIndex})` : ""}${c.detail ? `: ${c.detail.slice(0, 120)}` : ""}`);
  } else lines.push("rules   unknown: the sidecar keeps these in memory, and has none for this transaction");
  return lines.join("\n");
}

export async function explainCommand(hash: Hex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "")) throw new Error("usage: vajra explain <hash>");
  console.log(render(await explain(hash)));
}
