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

// Match `$...$` ONLY when the content contains a backslash command
// (e.g. `\frac`, `\pi`, `\angle`). This avoids accidentally rendering
// currency like "$55 more than ... had $27" as math — the text
// between the two real-currency dollar signs has no LaTeX command,
// so the regex skips it and the dollar signs render as plain
// characters.
const MATH_SEGMENT_RE = /\$([^$\n]*\\[a-zA-Z][^$\n]*)\$/g;
// Inline decoration: **bold** and __underline__ in the same pass so
// either / both can appear inside a sentence.
const DECOR_RE = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;

function renderTextDecorations(text: string, keyBase: string): React.ReactNode[] {
  if (!text.includes("**") && !text.includes("__")) return [text];
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  DECOR_RE.lastIndex = 0;
  while ((m = DECOR_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={`${keyBase}b${m.index}`}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      out.push(
        <span key={`${keyBase}u${m.index}`} className="underline decoration-2">
          {m[2]}
        </span>
      );
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

export default function MathText({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  // Cheap pre-check: only enter the math-segment branch when the
  // string plausibly contains a LaTeX command. A bare `$` without
  // any `\command` is almost certainly currency and should fall
  // through to plain text + decoration rendering.
  if (!text.includes("$") || !/\\[a-zA-Z]/.test(text)) {
    return <span className={className}>{renderTextDecorations(text, "0")}</span>;
  }

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  MATH_SEGMENT_RE.lastIndex = 0;
  while ((m = MATH_SEGMENT_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push(...renderTextDecorations(text.slice(lastIdx, m.index), `t${m.index}`));
    }
    parts.push(<InlineMath key={`m${m.index}`} math={m[1]} />);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(...renderTextDecorations(text.slice(lastIdx), `tEnd`));
  }
  return <span className={className}>{parts}</span>;
}
