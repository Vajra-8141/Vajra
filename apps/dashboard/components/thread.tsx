import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

/** One person's money. Each moment exists because the one before it demands it. */
export const MOMENTS = [
  { n: 1, short: "You spend", title: "You spend, as you always have" },
  { n: 2, short: "Your seed is stolen", title: "Your seed is stolen, so the theft has to wait" },
  { n: 3, short: "You cancel it", title: "You cancel it from your phone" },
  { n: 4, short: "The thief blocks your exit", title: "The thief blocks your exit, so there is a second way in" },
  { n: 5, short: "You get paid privately", title: "You get paid privately" },
  { n: 6, short: "You lose the master key", title: "You lose the master key, so you recover by proof" },
  { n: 7, short: "You want private savings", title: "You want private savings, and the rules still hold" },
] as const;

/** Every page opens with why it exists: the moment in the story that made it necessary. */
export function PageHead({ moment, because, title, children }: { moment?: number; because?: string; title: string; children?: ReactNode }) {
  return (
    <header className="hero small">
      {because && (
        <Link className="because" href={moment ? `/story#moment-${moment}` : "/story"}>
          {moment ? `Moment ${moment}: ` : ""}
          {because}
        </Link>
      )}
      <h1>{title}</h1>
      {children && <p className="lead">{children}</p>}
    </header>
  );
}

/** And ends by pointing at the next dot. */
export function NextStep({ href, label, why }: { href: string; label: string; why: string }) {
  return (
    <Link className="next" href={href}>
      <span>
        <strong>{label}</strong>
        <span className="sub">{why}</span>
      </span>
      <ArrowRight size={20} aria-hidden />
    </Link>
  );
}
