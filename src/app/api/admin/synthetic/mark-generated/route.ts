import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

async function requireAdmin(userId: string | null) {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name?.toLowerCase() === "admin";
}

// Get or create a synthetic bank paper scoped to a given subject + level.
// These papers look like normal master papers (sourceExamId: null, paperType: null)
// so the existing daily-quiz filter picks their questions up automatically.
async function getOrCreateSyntheticBankPaper(adminUserId: string, subject: string, level: string | null) {
  const title = `[Synthetic Bank] ${subject}${level ? " " + level : ""}`;
  const existing = await prisma.examPaper.findFirst({
    where: { title, paperType: null, sourceExamId: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.examPaper.create({
    data: {
      title,
      subject,
      level,
      userId: adminUserId,
      pageCount: 0,
      paperType: null,
      sourceExamId: null,
      extractionStatus: "ready",
      visible: true,
      examType: "Synthetic",
    },
    select: { id: true },
  });
  return created.id;
}

// POST { userId, questionId } → flags source ExamQuestion as syntheticGenerated=true
// and promotes any accepted SyntheticQuestion rows into real ExamQuestion rows in
// the synthetic bank paper for the source's subject+level.
export async function POST(request: NextRequest) {
  const { userId, questionId } = await request.json();
  if (!(await requireAdmin(userId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId) return NextResponse.json({ error: "Missing questionId" }, { status: 400 });

  const source = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      syllabusTopic: true,
      examPaper: { select: { subject: true, level: true } },
    },
  });
  if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

  const accepted = await prisma.syntheticQuestion.findMany({
    where: { sourceQuestionId: questionId },
    select: { variant: true, stem: true, options: true, correctAnswer: true, diagramImageData: true },
  });

  if (accepted.length > 0) {
    const bankPaperId = await getOrCreateSyntheticBankPaper(userId, source.examPaper.subject ?? "Unknown", source.examPaper.level ?? null);
    const existingCount = await prisma.examQuestion.count({ where: { examPaperId: bankPaperId } });
    let nextOrder = existingCount;
    for (const v of accepted) {
      nextOrder += 1;
      await prisma.examQuestion.create({
        data: {
          questionNum: `S${nextOrder}`,
          imageData: "",
          answer: `(${v.correctAnswer})`,
          pageIndex: 0,
          orderIndex: nextOrder,
          marksAvailable: 2,
          examPaperId: bankPaperId,
          syllabusTopic: source.syllabusTopic ?? null,
          transcribedStem: v.stem,
          transcribedOptions: v.options as unknown as string[],
          diagramImageData: v.diagramImageData ?? null,
          sourceQuestionId: source.id,
        },
      });
    }
  }

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { syntheticGenerated: true },
  });

  return NextResponse.json({ ok: true, promoted: accepted.length });
}
