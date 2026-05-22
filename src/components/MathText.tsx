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

// Math segment: `$...$` containing at least one math-only character —
// a LaTeX `\command`, OR a superscript `^`, subscript `_`, or brace
// `{ }`. The triggers exist to leave plain currency ("$5", "$27")
// alone while still picking up cases like "cm$^2$" or "$x_n$" that
// don't carry a backslash-command.
const MATH_SEGMENT_RE = /\$([^$\n]*[\\^_{}][^$\n]*)\$/;
// Bold and underline — non-greedy, content cannot contain newlines.
// Underline requires the two surrounding underscores to be ISOLATED:
// no `_` immediately before the opening pair, none immediately after
// the closing pair, and the content itself cannot start or end with
// `_`. Without these guards a run like "___ XX __" would partially
// match and wrongly underline " XX ".
const BOLD_RE = /\*\*([^\n]+?)\*\*/;
const UNDER_RE = /(?<!_)__(?!_)([^_\n][^\n]*?[^_\n]|[^_\n])(?<!_)__(?!_)/;
// Tag-style underline that older extractions emitted:
// `[underline]word[/underline]` and `<u>word</u>`. RichLine on /edit
// already handles these; MathText needs to as well so the quiz UI
// shows underline for legacy data without forcing a re-extract.
const UNDER_TAG_RE = /\[underline\]([^[\n]+?)\[\/underline\]/;
const UNDER_HTML_RE = /<u>([^<\n]+?)<\/u>/;

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
    { kind: "underline", m: UNDER_TAG_RE.exec(text) },
    { kind: "underline", m: UNDER_HTML_RE.exec(text) },
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
  if (
    !repaired.includes("$") &&
    !repaired.includes("**") &&
    !repaired.includes("__") &&
    !repaired.includes("[underline]") &&
    !repaired.includes("<u>")
  ) {
    return <span className={className} style={style}>{repaired}</span>;
  }
  return <span className={className} style={style}>{renderInline(repaired, "0")}</span>;
}
