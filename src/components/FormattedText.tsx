"use client";

import MathText from "./MathText";

// Renders text with **bold**, __underline__, `$…$` LaTeX math,
// and Markdown tables (| col1 | col2 |\n|---|---|\n| a | b |).
//
// Inline formatting still goes through MathText. Markdown tables are
// extracted out of the body first, rendered as real HTML <table>s with
// 2px black borders so they look like printed exam-paper tables, and
// the surrounding prose continues to render via MathText.
type Segment =
  | { kind: "text"; value: string }
  | { kind: "table"; header: string[]; rows: string[][] };

/** Match a Markdown GFM-style pipe table:
 *    | col1 | col2 |
 *    |------|------|   (separator: |---|---| with optional :)
 *    | a    | b    |
 *    | c    | d    |
 *  Captures the whole block (header + separator + 1+ data rows).
 */
const TABLE_RE = /(^|\n)((?:\|[^\n]*\|[ \t]*\n)\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|[ \t]*\n(?:\|[^\n]*\|[ \t]*\n?)+)/g;

function splitCells(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map(c => c.trim());
}

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  TABLE_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = TABLE_RE.exec(text)); ) {
    const block = m[2];
    const matchStart = m.index + m[1].length; // skip the leading newline we captured
    if (matchStart > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, matchStart) });
    }
    const lines = block.trim().split("\n");
    // lines[0] = header, lines[1] = separator, lines[2..] = data
    const header = splitCells(lines[0]);
    const rows = lines.slice(2).map(splitCells);
    segments.push({ kind: "table", header, rows });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  if (segments.length === 0) segments.push({ kind: "text", value: text });
  return segments;
}

export default function FormattedText({ text, className }: { text: string; className?: string }) {
  if (!text) return <p className={className} />;
  if (!text.includes("|")) {
    // Fast path — no possible table.
    return (
      <p className={className}>
        <MathText text={text} />
      </p>
    );
  }
  const segments = parseSegments(text);
  if (segments.length === 1 && segments[0].kind === "text") {
    return (
      <p className={className}>
        <MathText text={segments[0].value} />
      </p>
    );
  }
  return (
    <div className={className}>
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          // Trim leading/trailing newlines around table blocks so we
          // don't render an empty <p> between prose and the table.
          const trimmed = seg.value.replace(/^\n+|\n+$/g, "");
          if (!trimmed) return null;
          return <p key={i} className="whitespace-pre-wrap"><MathText text={trimmed} /></p>;
        }
        return (
          <div key={i} className="my-3 overflow-x-auto">
            <table className="border-collapse border-2 border-black text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {seg.header.map((c, j) => (
                    <th key={j} className="border-2 border-black px-3 py-2 text-left font-bold text-[#0b1c30]">
                      <MathText text={c} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {seg.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} className="border-2 border-black px-3 py-2 align-top text-[#0b1c30]">
                        <MathText text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
