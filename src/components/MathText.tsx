"use client";

import React from "react";
import { InlineMath } from "react-katex";
import "katex/dist/katex.min.css";

// Renders a string that may contain LaTeX-delimited math segments
// (`$…$` inline) and/or `__underline__` text markup, interleaved with
// plain text. Plain text segments render as-is, math segments via
// KaTeX, underline segments wrapped in a styled span.
//
// Example: "What is $4\\frac{5}{6} - \\frac{1}{2}$?"
//   → "What is " + (KaTeX-rendered mixed fraction) + "?"
//
// If the input contains no `$` and no `__`, falls through to a plain
// string render so existing OCR-only stems aren't affected.

const MATH_SEGMENT_RE = /\$([^$\n]+?)\$/g;
const UNDERLINE_RE = /__([^_]+)__/g;

function renderTextWithUnderline(text: string, keyBase: string): React.ReactNode[] {
  if (!text.includes("__")) return [text];
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  UNDERLINE_RE.lastIndex = 0;
  while ((m = UNDERLINE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    out.push(
      <span key={`${keyBase}u${m.index}`} className="underline decoration-2">
        {m[1]}
      </span>
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

export default function MathText({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  if (!text.includes("$")) {
    return <span className={className}>{renderTextWithUnderline(text, "0")}</span>;
  }

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  MATH_SEGMENT_RE.lastIndex = 0;
  while ((m = MATH_SEGMENT_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push(...renderTextWithUnderline(text.slice(lastIdx, m.index), `t${m.index}`));
    }
    parts.push(<InlineMath key={`m${m.index}`} math={m[1]} />);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(...renderTextWithUnderline(text.slice(lastIdx), `tEnd`));
  }
  return <span className={className}>{parts}</span>;
}
