import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeLevel } from "@/lib/extraction";

// GET /api/migrate-levels — one-time migration to normalize level strings
export async function GET() {
  const papers = await prisma.examPaper.findMany({
    where: { level: { not: null } },
    select: { id: true, level: true },
  });

  let updated = 0;
  for (const p of papers) {
    const normalized = normalizeLevel(p.level);
    if (normalized && normalized !== p.level) {
      await prisma.examPaper.update({
        where: { id: p.id },
        data: { level: normalized },
      });
      updated++;
    }
  }

  return NextResponse.json({ total: papers.length, updated });
}
