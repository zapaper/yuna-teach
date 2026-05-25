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

// Match any `$...$` pair that isn't adjacent to another `$` (the
// `$$5` currency escape is rejected here and the post-render step
// collapses it to a single `$` for display). Whether a captured
// pair counts as MATH is then decided by isMathContent below.
const DOLLAR_PAIR_RE = /(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g;

// Decide whether the content inside `$...$` looks like LaTeX math.
// Rule order matters — first match wins, fast paths first:
//   1. Has a LaTeX backslash command, ^, _, { } or = → math
//      ("$\frac{1}{2}$", "$cm^2$", "$x = 6$").
//   2. Has at least one letter AND no whitespace at all → math
//      ("$y$", "$xy$", "$f(x)$", "$3x$"). Bare variables and
//      compact expressions never contain spaces.
//   3. Has at least one letter AND at least one math operator
//      (+ − * / < >) → math ("$x + y$", "$40 + 3x$"). The letter
//      requirement keeps currency arithmetic like "$5 + $7"
//      (content "5 + " — no letter) out.
// Anything else is treated as plain text. The big rejection target
// is currency prose like "Suyi bought cushions at $8 each and had
// $3 left" — content "8 each and had " has letters but also
// whitespace and no math operator, so it falls through.
function isMathContent(content: string): boolean {
  if (!content) return false;
  if (/[\\^_{}=]/.test(content)) return true;
  const hasLetter = /[a-zA-Z]/.test(content);
  if (!hasLetter) return false;
  if (!/\s/.test(content)) return true;
  if (/[+\-*/<>]/.test(content)) return true;
  return false;
}
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

// Find the earliest match for math, bold, or underline. Math is
// any `$...$` pair whose content passes isMathContent(); we scan
// every dollar pair sequentially because the first one might fail
// the math check (e.g. it's currency) but a later one is real math.
function findMathMatch(text: string): { index: number; end: number; content: string } | null {
  const re = new RegExp(DOLLAR_PAIR_RE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    if (isMathContent(m[1])) {
      return { index: m.index, end: m.index + m[0].length, content: m[1] };
    }
  }
  return null;
}

function firstMatch(text: string): MatchResult | null {
  const mathMatch = findMathMatch(text);
  const candidates: Array<{ kind: MatchResult["kind"]; index: number; end: number; content: string } | null> = [
    mathMatch ? { kind: "math" as const, ...mathMatch } : null,
  ];
  const others: Array<{ kind: MatchResult["kind"]; m: RegExpExecArray | null }> = [
    { kind: "bold", m: BOLD_RE.exec(text) },
    { kind: "underline", m: UNDER_RE.exec(text) },
    { kind: "underline", m: UNDER_TAG_RE.exec(text) },
    { kind: "underline", m: UNDER_HTML_RE.exec(text) },
  ];
  for (const c of others) {
    if (!c.m) continue;
    candidates.push({
      kind: c.kind,
      index: c.m.index,
      end: c.m.index + c.m[0].length,
      content: c.m[1],
    });
  }
  let best: MatchResult | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (best === null || c.index < best.index) {
      best = { index: c.index, end: c.end, kind: c.kind, content: c.content };
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
  // Still collapse the `$$` currency escape so newer extractions
  // display as a single dollar sign.
  if (
    !repaired.includes("$") &&
    !repaired.includes("**") &&
    !repaired.includes("__") &&
    !repaired.includes("[underline]") &&
    !repaired.includes("<u>")
  ) {
    return <span className={className} style={style}>{repaired}</span>;
  }
  if (repaired.includes("$") && !repaired.includes("**") && !repaired.includes("__") && !repaired.includes("[underline]") && !repaired.includes("<u>") && !findMathMatch(repaired)) {
    // Has dollars but no math match anywhere → plain text with
    // currency escapes collapsed.
    return <span className={className} style={style}>{repaired.replace(/\$\$/g, "$")}</span>;
  }
  return <span className={className} style={style}>{renderInlineAndCollapseCurrency(repaired, "0")}</span>;
}

// Wrap renderInline so any string-typed children come out with the
// `$$` currency escape collapsed to a single `$` for display.
function renderInlineAndCollapseCurrency(text: string, keyBase: string): React.ReactNode[] {
  return renderInline(text, keyBase).map((node, i) =>
    typeof node === "string" ? node.replace(/\$\$/g, "$") : node,
  );
}
