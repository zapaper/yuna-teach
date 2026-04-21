import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// One-off backfill: for every ExamQuestion on a Synthetic Bank paper, copy the
// source question's paper examType into syntheticSourceExamType. Idempotent —
// only writes rows where the new field is still null.
export async function POST() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const bankPapers = await prisma.examPaper.findMany({
    where: { title: { startsWith: "[Synthetic Bank]" } },
    select: { id: true },
  });
  const bankPaperIds = bankPapers.map(p => p.id);
  if (bankPaperIds.length === 0) {
    return NextResponse.json({ scanned: 0, updated: 0, skipped: 0, note: "No synthetic bank papers found." });
  }

  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: bankPaperIds },
      sourceQuestionId: { not: null },
      syntheticSourceExamType: null,
    },
    select: { id: true, sourceQuestionId: true },
  });

  if (rows.length === 0) {
    return NextResponse.json({ scanned: 0, updated: 0, skipped: 0, note: "Nothing to backfill." });
  }

  // Batch-fetch source → source paper examType once.
  const sourceIds = [...new Set(rows.map(r => r.sourceQuestionId!).filter(Boolean))];
  const sources = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, examPaper: { select: { examType: true } } },
  });
  const srcExamType = new Map<string, string | null>();
  for (const s of sources) srcExamType.set(s.id, s.examPaper.examType ?? null);

  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const et = srcExamType.get(r.sourceQuestionId!);
    if (!et) { skipped++; continue; }
    await prisma.examQuestion.update({
      where: { id: r.id },
      data: { syntheticSourceExamType: et },
    });
    updated++;
  }

  return NextResponse.json({ scanned: rows.length, updated, skipped });
}
