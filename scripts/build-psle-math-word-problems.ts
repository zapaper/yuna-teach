// Compile diagram-free PSLE math word problems (≥ 4 marks) into a
// Word doc with full question text + step-by-step solution.
// Output: eval/psle-math-word-problems.docx

import { promises as fs } from "fs";
import path from "path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { prisma } from "../src/lib/db";

// Heuristic: skip anything whose stem mentions a figure / picture /
// diagram / chart / graph / table — keep pure word problems only.
const DIAGRAM_RE = /\b(figure|figures|diagram|drawing|drawn|picture|graph|chart|table|shown|shown above|shown below|as below|as shown|the (square|rectangle|triangle|circle|pentagon|hexagon|trapezium|rhombus|parallelogram)|grid)\b/i;

// Geometry questions almost always name vertices in capital-letter
// sequences ("ABC", "ABCD", "PQR"). Drop anything that looks like a
// vertex label even without an explicit "figure" cue.
const VERTEX_LABEL_RE = /\b[A-Z]{2,5}\b/;

// Shape-name kicker — catches "ABC is an equilateral triangle" / "ABCD is
// a rhombus" patterns that DIAGRAM_RE misses because there's no leading
// "the". If the stem says "<word> is a/an <shape>", it's geometry.
const SHAPE_RE = /\b(equilateral|isosceles|right-angled|scalene|square|rectangle|rhombus|trapezium|parallelogram|pentagon|hexagon|circle|cylinder|sphere|cube|cuboid|prism)\b/i;

// Replace LaTeX inline math with a flat ASCII rendition (no images here).
function flattenLatex(s: string): string {
  if (!s) return s;
  return s
    .replace(/\$\\frac\{(\d+)\}\{(\d+)\}\$/g, "$1/$2")
    .replace(/\\frac\{(\d+)\}\{(\d+)\}/g, "$1/$2")
    .replace(/\$([^$]+)\$/g, "$1")
    .replace(/\$\$/g, "$");
}

// Split the answer key on " | " (the marker's per-step separator).
function splitAnswerSteps(answer: string | null): string[] {
  if (!answer) return [];
  return answer
    .split("|")
    .map(s => flattenLatex(s.trim()))
    .filter(Boolean);
}

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      subject: { contains: "math", mode: "insensitive" },
      OR: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { examType: { contains: "PSLE", mode: "insensitive" } },
      ],
      // Only include masters with a year — strips out cloned quizzes.
      year: { not: null },
    },
    select: { id: true, title: true, year: true },
    orderBy: { year: "desc" },
  });
  const paperById = new Map(papers.map(p => [p.id, p]));

  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      marksAvailable: { gte: 4 },
      transcribedStem: { not: null },
    },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      transcribedStem: true, transcribedSubparts: true, answer: true,
      syllabusTopic: true, subTopic: true, examPaperId: true,
    },
  });

  type Sub = { label: string; text: string };
  type Picked = { q: typeof qs[number]; subs: Sub[]; paperTitle: string; year: string };
  const picked: Picked[] = [];
  const seenStems = new Set<string>();
  for (const q of qs) {
    const paper = paperById.get(q.examPaperId);
    if (!paper) continue;
    const stem = flattenLatex(q.transcribedStem ?? "");
    if (!stem.trim() || stem.length < 30) continue;
    // Drop anything with a diagram cue OR vertex labels OR shape names.
    if (DIAGRAM_RE.test(stem)) continue;
    if (VERTEX_LABEL_RE.test(stem)) continue;
    if (SHAPE_RE.test(stem)) continue;
    // Subparts can also mention diagrams / vertex labels / shapes.
    const subs = ((q.transcribedSubparts as Sub[] | null) ?? [])
      .filter(s => !s.label.startsWith("_"))
      .map(s => ({ label: s.label, text: flattenLatex(s.text) }));
    if (subs.some(s => DIAGRAM_RE.test(s.text) || VERTEX_LABEL_RE.test(s.text) || SHAPE_RE.test(s.text))) continue;
    // Same answer also must avoid diagram references (e.g. "see figure").
    if (DIAGRAM_RE.test(q.answer ?? "")) continue;
    // Dedupe by stem prefix so master + clone don't both land.
    const key = stem.slice(0, 80).trim();
    if (seenStems.has(key)) continue;
    seenStems.add(key);
    picked.push({ q, subs, paperTitle: paper.title, year: paper.year ?? "?" });
  }

  // Sort: more marks first, then newer year. Cap to a manageable size.
  picked.sort((a, b) =>
    (b.q.marksAvailable ?? 0) - (a.q.marksAvailable ?? 0) ||
    b.year.localeCompare(a.year)
  );
  const chosen = picked.slice(0, 15);

  console.log(`Picked ${chosen.length} of ${picked.length} candidates (from ${qs.length} 4+ mark questions).`);

  // Build the Word doc.
  const children: Array<Paragraph> = [];
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: "PSLE Math — Diagram-Free Word Problems (≥ 4 marks)" })],
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Compiled ${new Date().toISOString().slice(0, 10)} · ${chosen.length} questions from PSLE 2016–2025`, italics: true })],
  }));
  children.push(new Paragraph({ children: [new TextRun("")] }));

  for (let i = 0; i < chosen.length; i++) {
    const { q, subs, paperTitle, year } = chosen[i];
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `${i + 1}. ${paperTitle} (${year}) — Q${q.questionNum} · ${q.marksAvailable} marks` })],
    }));
    if (q.syllabusTopic) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `Topic: ${q.syllabusTopic}${q.subTopic ? ` / ${q.subTopic}` : ""}`, italics: true, color: "666666" })],
      }));
    }
    children.push(new Paragraph({ children: [new TextRun("")] }));

    // Question
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: "Question" })],
    }));
    const stem = flattenLatex(q.transcribedStem ?? "");
    for (const line of stem.split(/\n+/)) {
      if (line.trim()) children.push(new Paragraph({ children: [new TextRun(line.trim())] }));
    }
    if (subs.length > 0) {
      for (const sp of subs) {
        children.push(new Paragraph({
          children: [new TextRun({ text: `(${sp.label}) `, bold: true }), new TextRun(sp.text)],
        }));
      }
    }
    children.push(new Paragraph({ children: [new TextRun("")] }));

    // Solution
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: "Solution" })],
    }));
    const steps = splitAnswerSteps(q.answer);
    for (const step of steps) {
      // Bold any line that looks like a part header "(a)", "(b-i)".
      const partHeader = /^\(?\s*[a-z](?:-[ivx]+)?\s*\)/i.exec(step);
      if (partHeader) {
        const headerLen = partHeader[0].length;
        children.push(new Paragraph({
          children: [
            new TextRun({ text: step.slice(0, headerLen) + " ", bold: true }),
            new TextRun(step.slice(headerLen).trim()),
          ],
        }));
      } else {
        children.push(new Paragraph({ children: [new TextRun(step)] }));
      }
    }
    children.push(new Paragraph({ children: [new TextRun("")] }));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  const buf = await Packer.toBuffer(doc);
  const outPath = path.join(process.cwd(), "eval", "psle-math-word-problems.docx");
  await fs.writeFile(outPath, buf);
  console.log(`Wrote ${outPath}`);
  process.exit(0);
}
main();
