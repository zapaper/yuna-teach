// Build a Word document showcasing 10 PSLE English continuous-writing
// model essays with the CLIMAX and RESOLUTION sections highlighted.
// Intended as a teaching artefact for Mark and David — they can see
// how the model essays land the most-important narrative beats.
//
// Pipeline:
//   1. Pull EnglishSupplementaryPaper rows that have continuousModel
//      set (each row's continuousModel is one full essay).
//   2. For each essay ask Gemini to identify the exact CLIMAX span
//      and RESOLUTION span (verbatim substrings from the essay).
//   3. Render to docx with:
//        · climax highlighted yellow
//        · resolution highlighted green
//   4. Save into the shared OneDrive folder.
//
// Run:  npx tsx scripts/_build-climax-resolution-doc.ts

import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel,
} from "docx";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";
import { safeJsonParse } from "../src/lib/compo-analysis";

const OUTPUT_DIR = path.join(
  os.homedir(),
  "OneDrive", "Documents", "MarkForYou",
);
const OUTPUT_FILE = "MarkForYou-PSLE-English-Climax-Resolution-Models.docx";

const MODEL = "gemini-2.5-flash";

// ── Step 1: Gemini identifies climax + resolution spans ───────────

type AnchorSpan = { startPhrase: string; endPhrase: string };
type Span = { climax: { start: number; end: number } | null; resolution: { start: number; end: number } | null };

async function askGeminiForAnchors(essay: string, year: string, theme: string | null): Promise<{ climax: AnchorSpan; resolution: AnchorSpan }> {
  const prompt = `You are a Singapore PSLE English writing teacher. Below is a model continuous-writing essay from year ${year}${theme ? ` on the theme "${theme}"` : ""}. Identify the CLIMAX and the RESOLUTION.

Definitions (PSLE narrative terms):
- CLIMAX: the moment of highest tension or turning point — the conflict reaches its peak (the disaster strikes, the discovery happens, the decision is made). Pick the 2–6 sentences that contain this peak moment with its sensory / emotional detail.
- RESOLUTION: how things settle afterwards — the outcome, the character's reflection, the lesson, the changed state. Pick the 2–5 sentences from the final paragraphs that show the wrap-up.

For each, return the FIRST 8-12 words VERBATIM (the exact opening phrase of the span) and the LAST 8-12 words VERBATIM (the exact closing phrase of the span). Copy them exactly as they appear in the essay — same words, same punctuation, same case. We will use these anchors to locate the span in the source text.

If the essay has no clear climax or resolution, return empty strings for that section's startPhrase and endPhrase.

Essay:
---
${essay}
---

Output strict JSON:
{
  "climax":     { "startPhrase": "<first 8-12 words verbatim>", "endPhrase": "<last 8-12 words verbatim>" },
  "resolution": { "startPhrase": "<first 8-12 words verbatim>", "endPhrase": "<last 8-12 words verbatim>" }
}
`;
  const resp = await generateContentWithRetry({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 2000 },
  }, 2, 5000, `climax-${year}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = safeJsonParse((resp.text ?? "").trim(), `climax-${year}`) as any;
  const norm = (a: unknown): AnchorSpan => {
    const o = (a ?? {}) as Record<string, unknown>;
    return {
      startPhrase: String(o.startPhrase ?? "").trim(),
      endPhrase: String(o.endPhrase ?? "").trim(),
    };
  };
  return { climax: norm(parsed.climax), resolution: norm(parsed.resolution) };
}

// Normalised find — collapse whitespace + normalise quotes for the
// substring match, but return the position in the ORIGINAL essay.
// Builds an index map from normalised-position → original-position
// once and re-uses it.
function makeFinder(essay: string) {
  const map: number[] = []; // map[normalised-index] = original-index
  let normalised = "";
  for (let i = 0; i < essay.length; i++) {
    const ch = essay[i];
    let out = ch;
    // Normalise curly quotes to straight.
    if (ch === "‘" || ch === "’") out = "'";
    else if (ch === "“" || ch === "”") out = '"';
    else if (ch === "–" || ch === "—") out = "-"; // en/em dash → hyphen
    // Collapse runs of whitespace to a single space.
    if (/\s/.test(out)) {
      if (normalised.length === 0 || normalised[normalised.length - 1] === " ") continue;
      out = " ";
    }
    normalised += out;
    map.push(i);
  }
  const normalise = (s: string): string => {
    let n = "";
    for (let i = 0; i < s.length; i++) {
      let ch = s[i];
      if (ch === "‘" || ch === "’") ch = "'";
      else if (ch === "“" || ch === "”") ch = '"';
      else if (ch === "–" || ch === "—") ch = "-";
      if (/\s/.test(ch)) {
        if (n.length === 0 || n[n.length - 1] === " ") continue;
        ch = " ";
      }
      n += ch;
    }
    return n.trim();
  };
  return {
    findOriginalStart: (phrase: string): number | null => {
      const n = normalise(phrase);
      if (n.length === 0) return null;
      const at = normalised.indexOf(n);
      if (at < 0) return null;
      return map[at];
    },
    findOriginalEnd: (phrase: string, after: number): number | null => {
      const n = normalise(phrase);
      if (n.length === 0) return null;
      // Find the normalised position that maps to >= after.
      let normAfter = 0;
      while (normAfter < map.length && map[normAfter] < after) normAfter++;
      const at = normalised.indexOf(n, normAfter);
      if (at < 0) return null;
      // End position in original = map of the last char of the matched
      // normalised span, +1.
      const lastNormIdx = at + n.length - 1;
      if (lastNormIdx >= map.length) return null;
      return map[lastNormIdx] + 1;
    },
  };
}

async function identifyClimaxResolution(essay: string, year: string, theme: string | null): Promise<Span> {
  const anchors = await askGeminiForAnchors(essay, year, theme);
  const finder = makeFinder(essay);
  const resolveSpan = (a: AnchorSpan) => {
    if (!a.startPhrase || !a.endPhrase) return null;
    const start = finder.findOriginalStart(a.startPhrase);
    if (start === null) return null;
    const end = finder.findOriginalEnd(a.endPhrase, start);
    if (end === null || end <= start) return null;
    // Sanity: span shouldn't be more than 70% of the essay.
    if (end - start > essay.length * 0.7) return null;
    return { start, end };
  };
  return {
    climax: resolveSpan(anchors.climax),
    resolution: resolveSpan(anchors.resolution),
  };
}

// ── Step 2: render essay with highlighted spans ───────────────────

// Yellow shading for climax, light-green for resolution. docx uses
// hex without the leading #. Pick visible-but-readable shades.
const CLIMAX_HL = "FFF59D";    // soft yellow
const RESOLUTION_HL = "C8E6C9"; // soft green

type Highlight = { start: number; end: number; color: string; label: "climax" | "resolution" };

function buildRuns(text: string, highlights: Highlight[]): TextRun[] {
  // Sort non-overlapping; if they overlap, the first one wins.
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  const clean: Highlight[] = [];
  let lastEnd = 0;
  for (const h of sorted) {
    if (h.start < lastEnd) continue; // skip overlap
    clean.push(h);
    lastEnd = h.end;
  }
  const runs: TextRun[] = [];
  let pos = 0;
  for (const h of clean) {
    if (h.start > pos) {
      runs.push(new TextRun({ text: text.slice(pos, h.start), font: "Calibri", size: 22 }));
    }
    runs.push(new TextRun({
      text: text.slice(h.start, h.end),
      font: "Calibri",
      size: 22,
      shading: { type: "clear", color: "auto", fill: h.color },
    }));
    pos = h.end;
  }
  if (pos < text.length) {
    runs.push(new TextRun({ text: text.slice(pos), font: "Calibri", size: 22 }));
  }
  return runs;
}

function paragraphsForEssay(essay: string, span: Span): Paragraph[] {
  const highlights: Highlight[] = [];
  if (span.climax) {
    highlights.push({ start: span.climax.start, end: span.climax.end, color: CLIMAX_HL, label: "climax" });
  }
  if (span.resolution) {
    highlights.push({ start: span.resolution.start, end: span.resolution.end, color: RESOLUTION_HL, label: "resolution" });
  }
  // Split the essay into paragraphs by blank lines; each paragraph
  // gets its own Paragraph block but highlights persist across them.
  const paraStarts: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  const lines = essay.split("\n");
  for (const line of lines) {
    const end = cursor + line.length;
    paraStarts.push({ start: cursor, end, text: line });
    cursor = end + 1; // +1 for the \n that follows
  }
  // Merge consecutive non-empty lines into paragraphs; keep blank
  // lines as paragraph breaks.
  const docParas: Array<{ start: number; end: number; text: string }> = [];
  let buf: { start: number; end: number; text: string } | null = null;
  for (const ln of paraStarts) {
    if (ln.text.trim() === "") {
      if (buf) { docParas.push(buf); buf = null; }
    } else {
      if (!buf) buf = { ...ln };
      else { buf.end = ln.end; buf.text = essay.slice(buf.start, ln.end); }
    }
  }
  if (buf) docParas.push(buf);

  return docParas.map(p => {
    const localHl = highlights
      .filter(h => h.end > p.start && h.start < p.end)
      .map(h => ({
        start: Math.max(h.start, p.start) - p.start,
        end: Math.min(h.end, p.end) - p.start,
        color: h.color,
        label: h.label,
      }));
    return new Paragraph({
      spacing: { before: 80, after: 80, line: 320 },
      children: buildRuns(p.text, localHl),
    });
  });
}

// ── Step 3: build the document ────────────────────────────────────

async function main() {
  console.log("Loading model essays...");
  const papers = await prisma.englishSupplementaryPaper.findMany({
    where: { continuousModel: { not: null } },
    select: { year: true, continuousTheme: true, continuousModel: true },
    orderBy: { year: "desc" },
    take: 10,
  });
  console.log(`Found ${papers.length} paper(s) with model essays.\n`);

  const sections: Paragraph[] = [];

  // Title + legend
  sections.push(new Paragraph({
    spacing: { after: 160 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "PSLE English — Climax & Resolution Models", bold: true, size: 36, font: "Calibri" })],
  }));
  sections.push(new Paragraph({
    spacing: { after: 80 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "10 model continuous-writing essays from PSLE markers, with the highest-impact narrative beats highlighted so you can see the shape of what scores 33-36.", italics: true, color: "555555", size: 22, font: "Calibri" })],
  }));
  sections.push(new Paragraph({
    spacing: { after: 240 },
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: "Legend: ", bold: true, font: "Calibri", size: 22 }),
      new TextRun({ text: " CLIMAX ", font: "Calibri", size: 22, shading: { type: "clear", color: "auto", fill: CLIMAX_HL } }),
      new TextRun({ text: "  ", font: "Calibri", size: 22 }),
      new TextRun({ text: " RESOLUTION ", font: "Calibri", size: 22, shading: { type: "clear", color: "auto", fill: RESOLUTION_HL } }),
    ],
  }));

  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    const essay = (p.continuousModel ?? "").trim();
    if (essay.length < 200) continue;
    console.log(`[${i + 1}/${papers.length}] ${p.year} "${p.continuousTheme ?? "?"}" — calling Gemini...`);
    const span = await identifyClimaxResolution(essay, p.year, p.continuousTheme);
    const cLen = span.climax ? span.climax.end - span.climax.start : 0;
    const rLen = span.resolution ? span.resolution.end - span.resolution.start : 0;
    console.log(`  climax: ${cLen > 0 ? "yes (" + cLen + " chars)" : "no"}, resolution: ${rLen > 0 ? "yes (" + rLen + " chars)" : "no"}`);

    // Essay header
    sections.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 360, after: 120 },
      children: [
        new TextRun({ text: `${p.year}`, bold: true, font: "Calibri", size: 28 }),
        new TextRun({ text: p.continuousTheme ? ` — ${p.continuousTheme}` : "", italics: true, color: "555555", font: "Calibri", size: 26 }),
      ],
    }));

    sections.push(...paragraphsForEssay(essay, span));
  }

  const doc = new Document({
    creator: "MarkForYou",
    title: "PSLE English Climax & Resolution Models",
    description: "10 model essays with climax and resolution highlighted.",
    sections: [{
      properties: {
        page: {
          margin: { top: 1100, right: 1100, bottom: 1100, left: 1100 },
        },
      },
      children: sections,
    }],
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, OUTPUT_FILE);
  const buf = await Packer.toBuffer(doc);
  writeFileSync(outPath, buf);
  console.log(`\nWrote ${outPath} (${(buf.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
