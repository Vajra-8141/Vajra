import type { ReactNode } from "react";

export type StampTone = "red" | "violet" | "green" | "saffron";

/** The one loud thing in this design: every outcome the chain gives lands as a rubber stamp. `exact` keeps the case of a contract's error name, which is what a reader will search for. */
export function Stamp({ tone, children, sub, still, exact }: { tone: StampTone; children: ReactNode; sub?: ReactNode; still?: boolean; exact?: boolean }) {
  return (
    <span className={`stamp ${tone} ${still ? "still" : ""} ${exact ? "exact" : ""}`}>
      <span className="stamp-word">{children}</span>
      {sub && <span className="stamp-sub">{sub}</span>}
    </span>
  );
}
