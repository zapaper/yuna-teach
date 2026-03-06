import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeLevel, normalizeSubject } from "@/lib/extraction";

// GET /api/migrate-levels — one-time migration to normalize level and subject strings
export async function GET() {
  const papers = await prisma.examPaper.findMany({
    select: { id: true, level: true, subject: true },
  });

  let levelsUpdated = 0;
  let subjectsUpdated = 0;
  for (const p of papers) {
    const data: Record<string, string> = {};
    const normalizedLevel = normalizeLevel(p.level);
    if (normalizedLevel && normalizedLevel !== p.level) {
      data.level = normalizedLevel;
      levelsUpdated++;
    }
    const normalizedSubject = normalizeSubject(p.subject);
    if (normalizedSubject && normalizedSubject !== p.subject) {
      data.subject = normalizedSubject;
      subjectsUpdated++;
    }
    if (Object.keys(data).length > 0) {
      await prisma.examPaper.update({ where: { id: p.id }, data });
    }
  }

  return NextResponse.json({ total: papers.length, levelsUpdated, subjectsUpdated });
}
