import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET → summary of synthetic-bank inventory, grouped by subject + level +
// source examType. Used by the admin synthetic page to answer questions like
// "how many WA2 P6 math MCQ have I generated?" at a glance.
export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const bankPapers = await prisma.examPaper.findMany({
    where: { title: { startsWith: "[Synthetic Bank]" } },
    select: { id: true, subject: true, level: true },
  });
  const byPaperId = new Map<string, { subject: string | null; level: string | null }>();
  for (const p of bankPapers) byPaperId.set(p.id, { subject: p.subject, level: p.level });

  if (bankPapers.length === 0) {
    return NextResponse.json({ total: 0, groups: [] });
  }

  const rows = await prisma.examQuestion.findMany({
    where: { examPaperId: { in: [...byPaperId.keys()] } },
    select: { examPaperId: true, syntheticSourceExamType: true },
  });

  const agg = new Map<string, { subject: string; level: string; examType: string; count: number }>();
  for (const r of rows) {
    const meta = byPaperId.get(r.examPaperId)!;
    const subject = meta.subject ?? "Unknown";
    const level = meta.level ?? "Unknown";
    const examType = r.syntheticSourceExamType ?? "(untagged)";
    const key = `${subject}::${level}::${examType}`;
    const cur = agg.get(key) ?? { subject, level, examType, count: 0 };
    cur.count += 1;
    agg.set(key, cur);
  }

  const groups = [...agg.values()].sort((a, b) => {
    if (a.subject !== b.subject) return a.subject.localeCompare(b.subject);
    if (a.level !== b.level) return a.level.localeCompare(b.level);
    return a.examType.localeCompare(b.examType);
  });

  return NextResponse.json({ total: rows.length, groups });
}
