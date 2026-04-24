import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET ?paperId=<master-id> — returns empirical difficulty per master question
// derived from all clone attempts. Bucket: pct >= 90 → 1 (very easy),
// >= 75 → 2, >= 60 → 3, >= 40 → 4, else 5 (very hard). Only questions with
// ≥5 combined attempts get a value; fewer means "no signal yet".
export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const paperId = request.nextUrl.searchParams.get("paperId");
  if (!paperId) return NextResponse.json({ error: "paperId required" }, { status: 400 });

  const clones = await prisma.examPaper.findMany({
    where: { sourceExamId: paperId, markingStatus: { in: ["complete", "released"] } },
    select: {
      questions: {
        select: { questionNum: true, marksAwarded: true, marksAvailable: true },
      },
    },
  });

  const agg = new Map<string, { earned: number; available: number; attempts: number }>();
  for (const c of clones) {
    for (const q of c.questions) {
      if (q.marksAwarded == null || q.marksAvailable == null || q.marksAvailable === 0) continue;
      const cur = agg.get(q.questionNum) ?? { earned: 0, available: 0, attempts: 0 };
      cur.earned += q.marksAwarded;
      cur.available += q.marksAvailable;
      cur.attempts += 1;
      agg.set(q.questionNum, cur);
    }
  }

  const result: Record<string, { empiricalDifficulty: number | null; attempts: number; pct: number | null }> = {};
  for (const [questionNum, v] of agg.entries()) {
    const pct = v.available > 0 ? (v.earned / v.available) * 100 : null;
    let bucket: number | null = null;
    if (pct !== null && v.attempts >= 5) {
      bucket = pct >= 90 ? 1 : pct >= 75 ? 2 : pct >= 60 ? 3 : pct >= 40 ? 4 : 5;
    }
    result[questionNum] = { empiricalDifficulty: bucket, attempts: v.attempts, pct: pct !== null ? Math.round(pct) : null };
  }

  return NextResponse.json({ questions: result });
}
