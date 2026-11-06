/** The thunderbolt. Vajra is the thunderbolt that cannot be broken. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="mark-glyph" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M13.5 2 5 13.5h5.5L9.5 22 19 9.5h-6L13.5 2Z" />
    </svg>
  );
}
