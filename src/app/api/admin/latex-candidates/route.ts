import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// Detects mixed numbers ("4 5/6") AND bare fractions ("5/6") so OCR
// ambiguities can be re-rendered as proper LaTeX. Used on Math
// questions across the whole question pool — both MCQ and OEQ. The
// "fraction" detector deliberately requires word boundaries on both
// sides so we don't flag dates ("1/1/2024") or three-part ratios
// ("3:4:5"). Numbers separated only by `/` count.
const MIXED_NUMBER_RE = /\b\d+\s+\d+\/\d+\b/;
const BARE_FRACTION_RE = /(?<!\/|\d)\b\d+\/\d+\b(?!\/)/;

function hasFraction(s: string | null | undefined): boolean {
  if (!s) return false;
  return MIXED_NUMBER_RE.test(s) || BARE_FRACTION_RE.test(s);
}

// Walk all string-valued fields in a transcribedSubparts JSON blob
// looking for fractions.
function subpartsHaveFraction(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const sp of value) {
    if (sp && typeof sp === "object") {
      const text = (sp as { text?: unknown }).text;
      if (typeof text === "string" && hasFraction(text)) return true;
    }
  }
  return false;
}

// GET /api/admin/latex-candidates
//
// Returns Math questions (MCQ or OEQ) whose stem, options, subparts,
// or answer contain a fraction or mixed-number pattern likely to be
// misread by students. Candidates already containing `$` (LaTeX
// markers) are skipped.

export async function GET() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const candidates = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
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
      transcribedSubparts: true,
      answer: true,
      syllabusTopic: true,
      examPaper: { select: { id: true, title: true, level: true, examType: true } },
    },
    take: 5000,
  });

  const matches = candidates.filter(q => {
    const stem = q.transcribedStem ?? "";
    if (stem.includes("$")) return false; // already converted
    if (hasFraction(stem)) return true;

    const opts = q.transcribedOptions as unknown;
    if (Array.isArray(opts)) {
      for (const o of opts) {
        if (typeof o === "string" && hasFraction(o)) return true;
      }
    }

    if (subpartsHaveFraction(q.transcribedSubparts)) return true;

    if (hasFraction(q.answer)) return true;

    return false;
  }).map(q => {
    const opts = q.transcribedOptions as unknown;
    const isMcq = Array.isArray(opts) && opts.filter((o): o is string => typeof o === "string").length >= 2;
    return {
      id: q.id,
      questionNum: q.questionNum,
      isMcq,
      transcribedStem: q.transcribedStem,
      transcribedOptions: q.transcribedOptions,
      transcribedSubparts: q.transcribedSubparts,
      answer: q.answer,
      syllabusTopic: q.syllabusTopic,
      paper: q.examPaper,
    };
  });

  // Sort by paper title then question number.
  matches.sort((a, b) => {
    const at = a.paper.title ?? "";
    const bt = b.paper.title ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true });
  });

  return NextResponse.json({ count: matches.length, candidates: matches });
}
