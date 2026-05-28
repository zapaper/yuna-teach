// Convert the PSLE Science 2016-2025 deep-dive markdown to a Word doc
// so the user can read it without a markdown viewer. Mirrors the
// approach used by scripts/summary-to-docx.ts.

import * as fs from "fs";
import * as path from "path";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, ShadingType,
} from "docx";

const MD_PATH = path.join(__dirname, "..", "eval", "psle-science-deep-dive.md");
const OUT_PATH = path.join(__dirname, "..", "eval", "psle-science-deep-dive.docx");

function parseInline(text: string): TextRun[] {
  // **bold**, *italic*, `code`. Greedy but covers our doc.
  const runs: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index) }));
    const tok = m[0];
    if (tok.startsWith("**")) runs.push(new TextRun({ text: tok.slice(2, -2), bold: true }));
    else if (tok.startsWith("*")) runs.push(new TextRun({ text: tok.slice(1, -1), italics: true }));
    else if (tok.startsWith("`")) runs.push(new TextRun({ text: tok.slice(1, -1), font: "Consolas" }));
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }));
  return runs;
}

function buildTable(headerCells: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headerCells.map(t => new TableCell({
          shading: { type: ShadingType.SOLID, color: "DDDDDD" },
          children: [new Paragraph({ children: [new TextRun({ text: t.trim(), bold: true })] })],
        })),
      }),
      ...rows.map(row => new TableRow({
        children: row.map(cell => new TableCell({
          children: [new Paragraph({ children: parseInline(cell.trim()) })],
        })),
      })),
    ],
  });
}

(async () => {
  const md = fs.readFileSync(MD_PATH, "utf8");
  const lines = md.split("\n");
  const children: (Paragraph | Table)[] = [];

  let pendingTableHeader: string[] | null = null;
  let pendingTableRows: string[][] = [];

  function flushTable() {
    if (pendingTableHeader && pendingTableRows.length > 0) {
      children.push(buildTable(pendingTableHeader, pendingTableRows));
      children.push(new Paragraph({ children: [new TextRun("")] }));
    }
    pendingTableHeader = null;
    pendingTableRows = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table detection
    if (/^\|.*\|\s*$/.test(line)) {
      const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|");
      if (i + 1 < lines.length && /^\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
        flushTable();
        pendingTableHeader = cells;
        i++;
        continue;
      }
      if (pendingTableHeader) {
        pendingTableRows.push(cells);
        continue;
      }
    }
    if (pendingTableHeader && line.trim() === "") {
      flushTable();
      continue;
    }
    if (pendingTableHeader) flushTable();

    if (line.startsWith("# ")) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: parseInline(line.slice(2)) }));
    } else if (line.startsWith("## ")) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: parseInline(line.slice(3)) }));
    } else if (line.startsWith("### ")) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: parseInline(line.slice(4)) }));
    } else if (line.startsWith("---")) {
      children.push(new Paragraph({ children: [new TextRun({ text: "──────────────────────────────" })] }));
    } else if (line.startsWith("- ")) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: parseInline(line.slice(2)) }));
    } else if (/^\d+\.\s/.test(line)) {
      children.push(new Paragraph({ numbering: { reference: "list", level: 0 }, children: parseInline(line.replace(/^\d+\.\s/, "")) }));
    } else if (line.trim() === "") {
      children.push(new Paragraph({ children: [new TextRun("")] }));
    } else {
      children.push(new Paragraph({ children: parseInline(line) }));
    }
  }
  flushTable();

  const doc = new Document({
    numbering: {
      config: [{
        reference: "list", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "start" }],
      }],
    },
    sections: [{ children }],
  });
  fs.writeFileSync(OUT_PATH, await Packer.toBuffer(doc));
  console.log(`Wrote ${OUT_PATH}`);
})();
