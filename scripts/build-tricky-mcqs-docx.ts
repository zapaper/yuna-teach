// Compile the 4 tricky PSLE Science MCQs (which-bulb-brightest / gravity)
// into a Word doc, embedding the question crop image AND any option
// images that exist on the question row.
// Output: eval/tricky-psle-science-mcqs.docx

import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType } from "docx";
import { prisma } from "../src/lib/db";

// The 4 questions identified earlier (deduplicated by stem).
const TARGETS: Array<{
  id?: string; // resolved at runtime
  paperTitleHint: string;
  questionNum: string;
  trick: string;
}> = [
  {
    paperTitleHint: "Physical Science MCQ 2022-2024",
    questionNum: "8",
    trick: "Three of the four diagrams give bulb L the same current. Students compare numbers of components instead of tracing the actual current path — they miss that an 'extra' bulb on a parallel branch doesn't change L, and that a short-circuit wire across a battery does.",
  },
  {
    paperTitleHint: "PSLE Science 2025",
    questionNum: "18",
    trick: "Same family as Mariam's — three diagrams are equivalent for bulb G; the trap diagram (C here) changes G's series/parallel topology.",
  },
  {
    paperTitleHint: "PSLE Science 2016",
    questionNum: "18",
    trick: "Students often pick visually adjacent pairs. The matching pair is the one with equivalent current through the bulb — here that's the non-adjacent pair.",
  },
  {
    paperTitleHint: "PSLE Science 2018",
    questionNum: "15",
    trick: "Gravity acts on every object with mass at every instant — including at the peak of a jump where you're momentarily stationary. Students think gravity 'only kicks in when going down' or 'only when touching the ground'.",
  },
];

function dataUrlToBuffer(dataUrl: string | null | undefined): { buf: Buffer; mime: string } | null {
  if (!dataUrl) return null;
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) return null;
  return { buf: Buffer.from(m[2], "base64"), mime: m[1] };
}

// docx 9 ImageRun requires a `type` discriminant. Map mime to type string.
function imageTypeFromMime(mime: string): "png" | "jpg" | "gif" | "bmp" {
  if (mime.includes("png")) return "png";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("bmp")) return "bmp";
  return "jpg";
}

// Scale to maxWidth px while preserving aspect ratio.
async function fitTransform(buf: Buffer, maxWidth: number, maxHeight: number): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? maxWidth;
  const h = meta.height ?? maxHeight;
  const scale = Math.min(maxWidth / w, maxHeight / h, 1);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

async function imageParagraph(dataUrl: string | null | undefined, maxWidth: number, maxHeight: number, missingLabel: string): Promise<Paragraph> {
  const decoded = dataUrlToBuffer(dataUrl);
  if (!decoded) {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `(${missingLabel} — image missing)`, italics: true, color: "888888" })],
    });
  }
  const trans = await fitTransform(decoded.buf, maxWidth, maxHeight);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 60, after: 60 },
    children: [
      new ImageRun({
        data: decoded.buf,
        transformation: trans,
        type: imageTypeFromMime(decoded.mime),
      }),
    ],
  });
}

async function main() {
  // Resolve each target to a question row.
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null },
    select: { id: true, title: true, year: true },
  });
  const papersById = new Map(papers.map(p => [p.id, p]));

  type QRow = {
    id: string;
    questionNum: string;
    marksAvailable: number | null;
    imageData: string | null;
    transcribedStem: string | null;
    transcribedOptions: unknown;
    transcribedOptionImages: unknown;
    answer: string | null;
    syllabusTopic: string | null;
    examPaperId: string;
  };
  const resolved: Array<{ q: QRow; paper: { title: string; year: string | null }; trick: string }> = [];
  for (const t of TARGETS) {
    const matchingPapers = papers.filter(p => p.title.toLowerCase().includes(t.paperTitleHint.toLowerCase()));
    if (matchingPapers.length === 0) {
      console.warn(`No paper matched: ${t.paperTitleHint}`);
      continue;
    }
    const q = await prisma.examQuestion.findFirst({
      where: {
        examPaperId: { in: matchingPapers.map(p => p.id) },
        questionNum: t.questionNum,
      },
      select: {
        id: true, questionNum: true, marksAvailable: true,
        imageData: true, transcribedStem: true,
        transcribedOptions: true, transcribedOptionImages: true,
        answer: true, syllabusTopic: true, examPaperId: true,
      },
    });
    if (!q) {
      console.warn(`No question matched: ${t.paperTitleHint} Q${t.questionNum}`);
      continue;
    }
    const paper = papersById.get(q.examPaperId)!;
    resolved.push({ q, paper, trick: t.trick });
  }

  console.log(`Resolved ${resolved.length}/${TARGETS.length} questions.`);

  // Build the doc.
  const children: Paragraph[] = [];
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun("PSLE Science — Tricky MCQs (\"Always the Same\")")],
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Compiled ${new Date().toISOString().slice(0, 10)} · ${resolved.length} questions`, italics: true })],
  }));
  children.push(new Paragraph({ children: [new TextRun("")] }));

  for (let i = 0; i < resolved.length; i++) {
    const { q, paper, trick } = resolved[i];
    const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as Array<string | null>) : [];
    const optImgs = Array.isArray(q.transcribedOptionImages) ? (q.transcribedOptionImages as Array<string | null>) : [];

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun(`${i + 1}. ${paper.title} (${paper.year ?? "?"}) — Q${q.questionNum} · ${q.marksAvailable ?? "?"} mark${(q.marksAvailable ?? 0) === 1 ? "" : "s"}`)],
    }));
    if (q.syllabusTopic) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `Topic: ${q.syllabusTopic}`, italics: true, color: "666666" })],
      }));
    }

    // Question text (transcribed stem)
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun("Question")],
    }));
    const stem = (q.transcribedStem ?? "").trim();
    for (const line of stem.split(/\n+/)) {
      if (line.trim()) children.push(new Paragraph({ children: [new TextRun(line.trim())] }));
    }

    // Embed the cropped question image (includes diagrams).
    children.push(await imageParagraph(q.imageData, 500, 480, "question image"));

    // Options — for each, prefer the image if present, otherwise text.
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun("Options")],
    }));
    for (let oi = 0; oi < Math.max(opts.length, optImgs.length); oi++) {
      const text = opts[oi] ?? "";
      const img = optImgs[oi];
      children.push(new Paragraph({
        children: [new TextRun({ text: `(${oi + 1}) `, bold: true }), new TextRun(text || "(see image below)")],
      }));
      if (img) {
        children.push(await imageParagraph(img, 380, 260, `option ${oi + 1} image`));
      }
    }

    // Answer + trick
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun("Answer & Trick")],
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: "Answer: ", bold: true }), new TextRun(q.answer ?? "?")],
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: "The trick: ", bold: true }), new TextRun(trick)],
    }));
    children.push(new Paragraph({ children: [new TextRun("")] }));
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  const outPath = path.join(process.cwd(), "eval", "tricky-psle-science-mcqs.docx");
  await fs.writeFile(outPath, buf);
  console.log(`Wrote ${outPath}`);
  process.exit(0);
}
main();
