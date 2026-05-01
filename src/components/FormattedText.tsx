"use client";

import MathText from "./MathText";

// Renders text with **bold**, __underline__, and `$…$` LaTeX math
// markers. Delegated to MathText; the outer <p> is kept so callers
// can continue passing block-level classes (whitespace-pre-line,
// etc.).
export default function FormattedText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className}>
      <MathText text={text} />
    </p>
  );
}
