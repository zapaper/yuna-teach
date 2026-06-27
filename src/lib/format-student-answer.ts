// Convert a stored studentAnswer string into a parent-readable text
// representation. Mirrors the React version in page.tsx (formatStudentAnswer)
// but returns plain text so it can be used in email HTML.
//
// Three studentAnswer shapes seen in the wild:
//   1. Plain prose — return as-is.
//   2. JSON {"line0": "...", "line1": "..."} — multi-line OEQ writing
//      pad. Sort by index, join with newlines.
//   3. JSON {"r1c1": "...", "r2c1": "..."} — table cells. Group by
//      row, label each row (a), (b), (c) in order, join cells per
//      row with " / ", join rows with newlines.

export function formatStudentAnswerText(raw: string | null | undefined): string {
  if (!raw) return "";
  const txt = raw.trim();
  if (!(txt.startsWith("{") && txt.endsWith("}"))) return raw;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return raw;
  }

  // Line-shape ({"line0": "...", "line1": "..."}) — multi-line OEQ
  // writing pad. One thought per row.
  const lineEntries = Object.entries(parsed)
    .map(([k, v]) => {
      const m = k.match(/^line(\d+)$/i);
      return m ? { idx: parseInt(m[1], 10), value: String(v ?? "") } : null;
    })
    .filter((e): e is { idx: number; value: string } => e !== null)
    .sort((a, b) => a.idx - b.idx);
  if (lineEntries.length > 0) {
    const joined = lineEntries.map(e => e.value.trim()).filter(Boolean).join("\n");
    return joined || "(left blank)";
  }

  // Cell-shape ({"r1c0": "...", "r1c1": "..."}) — table answer. Group
  // by row, label rows (a)/(b)/(c)/(d) in order of appearance (since
  // row indices may skip, e.g. r1+r3 when r0/r2 are header rows the
  // kid doesn't fill).
  const cellEntries = Object.entries(parsed)
    .map(([k, v]) => {
      const m = k.match(/^r(\d+)c(\d+)$/i);
      return m ? { row: parseInt(m[1], 10), col: parseInt(m[2], 10), value: String(v ?? "") } : null;
    })
    .filter((e): e is { row: number; col: number; value: string } => e !== null)
    .sort((a, b) => a.row - b.row || a.col - b.col);
  if (cellEntries.length === 0) return raw;
  const byRow = new Map<number, string[]>();
  for (const e of cellEntries) {
    if (!byRow.has(e.row)) byRow.set(e.row, []);
    byRow.get(e.row)!.push(e.value);
  }
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]);
  const labelled = rows.map(([, vals], i) => {
    const letter = String.fromCharCode(97 + i); // a, b, c, ...
    const joined = vals.map(v => v.trim()).filter(Boolean).join(" / ");
    return `(${letter}) ${joined || "(left blank)"}`;
  });
  return labelled.join("\n");
}
