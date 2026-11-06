"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { GLOSSARY, type GlossaryId } from "../lib/glossary";

/** A word with its meaning a tap, hover or tab away. A click pins it open, so it works the same on a phone. */
export function Term({ id, children }: { id: GlossaryId; children?: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const tip = useId();
  const open = hovered || pinned;
  const entry = GLOSSARY[id];

  useEffect(() => {
    if (!pinned) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setPinned(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [pinned]);

  return (
    <span className="term" ref={box} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button type="button" className="term-word" aria-expanded={open} aria-describedby={open ? tip : undefined} onClick={() => setPinned((p) => !p)} onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}>
        {children ?? entry.term.toLowerCase()}
      </button>
      {open && (
        <span className="term-tip" role="tooltip" id={tip}>
          <strong>{entry.term}</strong> {entry.text}
        </span>
      )}
    </span>
  );
}
