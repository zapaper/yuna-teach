"use client";

import React from "react";
import { InlineMath } from "react-katex";
import "katex/dist/katex.min.css";

// Renders a string that may contain LaTeX-delimited math segments
// (`$…$` inline), `**bold**` and `__underline__` markup interleaved
// with plain text. Bold and underline can themselves contain math.
//
// Implementation: recursive scan. At each level we find the FIRST
// occurrence of any pattern (math, bold, underline), render that
// match (recursively rendering its content where applicable), and
// recurse on the text before and after. This handles arbitrary
// nesting like "**The fraction $\frac{1}{2}$ is half**" where the
// bold spans the math.

// Math segment: `$...$` containing at least one `\command` so plain
// currency ("$5", "$27") is left alone.
const MATH_SEGMENT_RE = /\$([^$\n]*\\[a-zA-Z][^$\n]*)\$/;
// Bold and underline — non-greedy, content cannot contain newlines.
const BOLD_RE = /\*\*([^\n]+?)\*\*/;
const UNDER_RE = /__([^\n]+?)__/;

// Repair common LaTeX escape losses caused by the AI emitting
// "$\frac{...}$" inside JSON string values without doubling the
// backslash. The JSON parser interprets `\f` as a form-feed char
// (U+000C); sometimes the form-feed survives into the rendered
// string, sometimes it gets stripped before reaching us.
//   1. Form-feed survived → replace U+000C with the two-char "\f".
//   2. Form-feed stripped → "$rac{" or "$3rac{" — re-prepend the \f.
function repairLatex(text: string): string {
  return text
    .replace(/\x0c/g, "\\f")
    .replace(/\$(\d+)rac\{/g, "$$$1\\frac{")
    .replace(/\$rac\{/g, "$\\frac{");
}

type MatchResult = {
  index: number;
  end: number;
  kind: "math" | "bold" | "underline";
  content: string;
};

// Find the earliest of the three patterns in `text`. Returns null
// if no pattern matches at all.
function firstMatch(text: string): MatchResult | null {
  const candidates: Array<{ kind: MatchResult["kind"]; m: RegExpExecArray | null }> = [
    { kind: "math", m: MATH_SEGMENT_RE.exec(text) },
    { kind: "bold", m: BOLD_RE.exec(text) },
    { kind: "underline", m: UNDER_RE.exec(text) },
  ];
  let best: MatchResult | null = null;
  for (const c of candidates) {
    if (!c.m) continue;
    const idx = c.m.index;
    if (best === null || idx < best.index) {
      best = {
        index: idx,
        end: idx + c.m[0].length,
        kind: c.kind,
        content: c.m[1],
      };
    }
  }
  return best;
}

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  while (cursor < text.length) {
    const slice = text.slice(cursor);
    const match = firstMatch(slice);
    if (!match) {
      out.push(text.slice(cursor));
      break;
    }
    if (match.index > 0) {
      out.push(text.slice(cursor, cursor + match.index));
    }
    const k = `${keyBase}-${i++}-${match.kind}`;
    if (match.kind === "math") {
      out.push(<InlineMath key={k} math={match.content} />);
    } else if (match.kind === "bold") {
      // Recurse so bold can contain math or underline.
      out.push(<strong key={k}>{renderInline(match.content, k)}</strong>);
    } else {
      out.push(
        <span key={k} className="underline decoration-2">
          {renderInline(match.content, k)}
        </span>,
      );
    }
    cursor += match.end;
  }
  return out;
}

export default function MathText({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const repaired = repairLatex(text);
  // Preserve newlines when present (e.g. labelled statements in
  // MCQ stems like "A.…\nB.…\nC.…"). HTML span collapses
  // whitespace by default, so an explicit `pre-line` is needed.
  // No-op for single-line text — `pre-line` only differs from
  // the default when there are actual line breaks.
  const style = repaired.includes("\n") ? { whiteSpace: "pre-line" as const } : undefined;
  // Cheap fast-path: no special markers → render as plain string.
  if (!repaired.includes("$") && !repaired.includes("**") && !repaired.includes("__")) {
    return <span className={className} style={style}>{repaired}</span>;
  }
  return <span className={className} style={style}>{renderInline(repaired, "0")}</span>;
}
