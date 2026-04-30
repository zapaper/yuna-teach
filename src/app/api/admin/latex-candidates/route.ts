import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Detects mixed numbers in the stem or options that LOOK like the
// kind of OCR ambiguity the user flagged ("4 5/6" misread as "45/6").
// Only flags Math MCQ questions on master papers (paperType: null,
// sourceExamId: null). Skips questions whose stem already contains
// `$` (already LaTeX'd).
const MIXED_NUMBER_RE = /\b\d+\s+\d+\/\d+\b/;

function hasMixedNumber(s: string | null | undefined): boolean {
  return !!s && MIXED_NUMBER_RE.test(s);
}

// GET /api/admin/latex-candidates
//
// Returns Math MCQ questions whose stem or any option contains a
// space-separated mixed number ("4 5/6" style) — candidates for
// admin LaTeX-fraction conversion.

export async function GET() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const candidates = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      transcribedOptions: { not: { equals: null } },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "math", mode: "insensitive" },
      },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      syllabusTopic: true,
      examPaper: { select: { id: true, title: true, level: true, examType: true } },
    },
    take: 5000,
  });

  // Filter to MCQ + has mixed number + not already LaTeX'd.
  const matches = candidates.filter(q => {
    const opts = q.transcribedOptions as unknown;
    if (!Array.isArray(opts) || opts.length < 2) return false;
    const optStrings = opts.filter((o): o is string => typeof o === "string");
    const stem = q.transcribedStem ?? "";
    if (stem.includes("$")) return false; // already converted
    if (hasMixedNumber(stem)) return true;
    if (optStrings.some(o => hasMixedNumber(o))) return true;
    return false;
  }).map(q => ({
    id: q.id,
    questionNum: q.questionNum,
    transcribedStem: q.transcribedStem,
    transcribedOptions: q.transcribedOptions,
    answer: q.answer,
    syllabusTopic: q.syllabusTopic,
    paper: q.examPaper,
  }));

  // Sort by paper title then question number for predictable
  // pagination through the admin UI.
  matches.sort((a, b) => {
    const at = a.paper.title ?? "";
    const bt = b.paper.title ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true });
  });

  return NextResponse.json({ count: matches.length, candidates: matches });
}
