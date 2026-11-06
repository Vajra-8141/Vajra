/** The double-ended bolt. Vajra means both thunderbolt and diamond. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="mark-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M12 1.5c3.6 3.2 4.6 7 1.4 10.5 3.2 3.5 2.2 7.3-1.4 10.5-3.6-3.2-4.6-7-1.4-10.5C7.4 8.5 8.4 4.7 12 1.5Z" />
      <path d="M7.5 12h9" strokeLinecap="round" />
    </svg>
  );
}
