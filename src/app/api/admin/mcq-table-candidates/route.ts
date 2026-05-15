import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/mcq-table-candidates?offset=0&limit=10
// Returns science MCQ master questions that:
//  - belong to a visible non-clone master paper
//  - have an MCQ answer (1/2/3/4)
//  - don't already carry a transcribedOptionTable
//  - aren't image-option MCQs
//  - have transcribedOptions that look INCOMPLETE — at least one entry is
//    blank/very short, OR multiple entries share a comma-separated row-like
//    shape (the symptom of an old extraction that flattened a table).
// Lets admin batch through them with manual eyeball + re-extract.
export async function GET(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get("limit") ?? "10", 10) || 10));

  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        subject: { contains: "cience" },
      },
      transcribedOptionTable: { equals: Prisma.DbNull },
      transcribedOptionImages: { equals: Prisma.DbNull },
      OR: [
        { answer: "1" }, { answer: "2" }, { answer: "3" }, { answer: "4" },
        { answer: "(1)" }, { answer: "(2)" }, { answer: "(3)" }, { answer: "(4)" },
      ],
    },
    select: {
      id: true, questionNum: true, answer: true, syllabusTopic: true,
      transcribedStem: true, transcribedOptions: true, imageData: true,
      diagramImageData: true,
      examPaper: { select: { id: true, title: true } },
    },
    orderBy: [{ examPaperId: "asc" }, { orderIndex: "asc" }],
  });

  const filtered = qs.filter(q => {
    const opts = q.transcribedOptions as unknown;
    // Strict criterion: only questions that DO have a transcribedOptions
    // array AND at least one of its entries is blank. The previous
    // version also returned questions with row-flattened comma patterns
    // (e.g. "evaporation, freezing") and questions with no options at
    // all — both can have legitimate non-table reasons for looking that
    // way (genuine compound options, or image-only MCQs that just
    // haven't been extracted yet). The blank-text-options signal is the
    // narrowest hit for "this was a table that didn't survive
    // extraction".
    if (!Array.isArray(opts) || opts.length === 0) return false;
    const strs = opts.map(o => String(o ?? "").trim());
    return strs.some(s => s.length === 0);
  });

  const page = filtered.slice(offset, offset + limit);
  return NextResponse.json({
    total: filtered.length,
    offset,
    limit,
    items: page.map(q => ({
      id: q.id,
      questionNum: q.questionNum,
      paperId: q.examPaper.id,
      paperTitle: q.examPaper.title,
      stem: q.transcribedStem,
      options: q.transcribedOptions,
      answer: q.answer,
      topic: q.syllabusTopic,
      imageData: q.imageData,
      diagramImageData: q.diagramImageData,
    })),
  });
}
