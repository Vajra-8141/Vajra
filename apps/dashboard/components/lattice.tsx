const CHAINS = 67;
const STEPS = 15;

/**
 * Where each of the 67 chains stops for a 32-byte value: 64 digits of base 16, then a 3-digit checksum, which is how a hash key at
 * w=16 picks its chains. Drawn from a transaction's hash, so it is a picture of the idea and not the signature itself.
 */
export function chainLevels(hash: string): number[] {
  const digits = hash.replace(/^0x/, "").padEnd(64, "0").slice(0, 64).split("").map((d) => parseInt(d, 16) || 0);
  const checksum = digits.reduce((sum, d) => sum + (STEPS - d), 0);
  return [...digits, (checksum >> 8) & 15, (checksum >> 4) & 15, checksum & 15];
}

/** The hash key's one visual: 67 bars. It appears only where the hash key has signed. */
export function Lattice({ hash, label }: { hash: string; label?: string }) {
  const levels = chainLevels(hash);
  return (
    <figure className="lattice">
      <svg viewBox={`0 0 ${CHAINS * 3} 32`} preserveAspectRatio="none" aria-hidden>
        {levels.map((level, i) => (
          <rect key={i} x={i * 3} y={32 - (level + 1) * 2} width="2" height={(level + 1) * 2} style={{ animationDelay: `${i * 4}ms` }} />
        ))}
      </svg>
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}
