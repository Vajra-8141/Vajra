import type { ReactNode } from "react";

export type StampTone = "red" | "violet" | "green" | "saffron";

/** Every outcome the chain gives lands here, in the chain's own words. `exact` marks a contract's error name, which is what a reader will search for. */
export function Stamp({ tone, children, sub, still, exact }: { tone: StampTone; children: ReactNode; sub?: ReactNode; still?: boolean; exact?: boolean }) {
  return (
    <span className={`stamp ${tone} ${still ? "still" : ""} ${exact ? "exact" : ""}`}>
      <span className="stamp-word">{children}</span>
      {sub && <span className="stamp-sub">{sub}</span>}
    </span>
  );
}
