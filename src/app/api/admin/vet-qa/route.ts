import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/vet-qa — return all questions with audit flags across all papers
export async function GET(_req: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Find papers with non-empty auditFlags
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, paperType: null },
    select: { id: true, title: true, subject: true, school: true, level: true, year: true, examType: true, metadata: true },
  });

  type FlaggedItem = {
    questionId: string;
    paperId: string;
    paperTitle: string;
    subject: string;
    questionNum: string;
    syllabusTopic: string | null;
    transcribedStem: string | null;
    transcribedOptions: unknown;
    answer: string | null;
    imageData: string | null;
    diagramImageData: string | null;
    marksAvailable: number | null;
    reason: string;
  };

  const items: FlaggedItem[] = [];

  for (const paper of papers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (paper.metadata ?? {}) as any;
    const flags = meta.auditFlags as Record<string, string> | undefined;
    if (!flags || Object.keys(flags).length === 0) continue;

    const flaggedIds = Object.keys(flags);
    const questions = await prisma.examQuestion.findMany({
      where: { id: { in: flaggedIds } },
      select: {
        id: true, questionNum: true, syllabusTopic: true,
        transcribedStem: true, transcribedOptions: true,
        answer: true, imageData: true, diagramImageData: true,
        marksAvailable: true,
      },
    });

    for (const q of questions) {
      items.push({
        questionId: q.id,
        paperId: paper.id,
        paperTitle: [paper.level, paper.subject, paper.examType, paper.school, paper.year].filter(Boolean).join(" · ") || paper.title,
        subject: paper.subject ?? "",
        questionNum: q.questionNum,
        syllabusTopic: q.syllabusTopic,
        transcribedStem: q.transcribedStem,
        transcribedOptions: q.transcribedOptions,
        answer: q.answer,
        imageData: q.imageData,
        diagramImageData: q.diagramImageData,
        marksAvailable: q.marksAvailable,
        reason: flags[q.id] ?? "",
      });
    }
  }

  return NextResponse.json({ items, total: items.length });
}

// POST /api/admin/vet-qa — clear a single question's audit flag after review
export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const { paperId, questionId } = await req.json();
  if (!paperId || !questionId) {
    return NextResponse.json({ error: "paperId and questionId required" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({ where: { id: paperId }, select: { metadata: true } });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (paper.metadata ?? {}) as any;
  if (meta.auditFlags && meta.auditFlags[questionId]) {
    delete meta.auditFlags[questionId];
    if (Object.keys(meta.auditFlags).length === 0) delete meta.auditFlags;
    await prisma.examPaper.update({ where: { id: paperId }, data: { metadata: meta } });
  }

  return NextResponse.json({ success: true });
}
