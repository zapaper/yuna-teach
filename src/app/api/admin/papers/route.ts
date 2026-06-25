import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guard";

export async function GET(_request: NextRequest) {
  // Caller comes from the session. The previous "name === 'admin'"
  // check was inconsistent with isAdmin() elsewhere — it missed
  // users granted admin via settings.admin = true. requireAdmin
  // uses isAdmin() and so admits both paths.
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null },
    select: {
      id: true,
      title: true,
      subject: true,
      level: true,
      school: true,
      year: true,
      examType: true,
      paperType: true,
      visible: true,
      extractionStatus: true,
      totalMarks: true,
      createdAt: true,
      userId: true,
      metadata: true,
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { questions: true, clones: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Compute Σ question.marksAvailable per paper in one groupBy so the
  // list view can flag papers whose stated totalMarks doesn't match the
  // questions' summed marks (Ai Tong Q39/Q40 missing → Δ+8, etc).
  const sums = await prisma.examQuestion.groupBy({
    by: ["examPaperId"],
    _sum: { marksAvailable: true },
    where: { examPaperId: { in: papers.map(p => p.id) } },
  });
  const summedByPaperId = new Map(sums.map(s => [s.examPaperId, s._sum.marksAvailable ?? 0]));

  // For each English/Chinese paper, summarise normal-extract completion:
  //   "complete" — every section flag true
  //   "partial"  — at least one flag true
  //   "none"     — no flags set / metadata.normalExtract<Lang> missing
  // null         — other subject (admin row hides the badge)
  const ENGLISH_SECTION_KEYS = ["bookletA", "grammarCloze", "editing", "compCloze", "synthesis", "compOeq"] as const;
  const CHINESE_SECTION_KEYS = ["yuwenMcq", "duanwen", "compMcq", "duihua", "compOeq"] as const;

  return NextResponse.json({
    papers: papers.map(p => {
      const subjLc = (p.subject ?? "").toLowerCase();
      const isEnglish = subjLc.includes("english");
      const isChinese = subjLc.includes("chinese");
      let normalExtractStatus: "complete" | "partial" | "none" | null = null;
      let normalExtractDoneCount = 0;
      let normalExtractTotalCount = 0;
      if (isEnglish) {
        const ne = ((p.metadata as { normalExtractEnglish?: Record<string, unknown> } | null)?.normalExtractEnglish ?? {}) as Record<string, unknown>;
        normalExtractDoneCount = ENGLISH_SECTION_KEYS.filter(k => ne[k] === true).length;
        normalExtractTotalCount = ENGLISH_SECTION_KEYS.length;
        if (normalExtractDoneCount === normalExtractTotalCount) normalExtractStatus = "complete";
        else if (normalExtractDoneCount > 0) normalExtractStatus = "partial";
        else normalExtractStatus = "none";
      } else if (isChinese) {
        const ne = ((p.metadata as { normalExtractChinese?: Record<string, unknown> } | null)?.normalExtractChinese ?? {}) as Record<string, unknown>;
        normalExtractDoneCount = CHINESE_SECTION_KEYS.filter(k => ne[k] === true).length;
        normalExtractTotalCount = CHINESE_SECTION_KEYS.length;
        if (normalExtractDoneCount === normalExtractTotalCount) normalExtractStatus = "complete";
        else if (normalExtractDoneCount > 0) normalExtractStatus = "partial";
        else normalExtractStatus = "none";
      }
      const stated = p.totalMarks ? parseFloat(p.totalMarks) : null;
      const summed = summedByPaperId.get(p.id) ?? 0;
      const marksDelta = stated != null && Number.isFinite(stated)
        ? Math.round((stated - summed) * 100) / 100
        : null;
      return {
        id: p.id,
        title: p.title,
        subject: p.subject,
        level: p.level,
        school: p.school,
        year: p.year,
        examType: p.examType,
        paperType: p.paperType,
        visible: p.visible,
        extractionStatus: p.extractionStatus,
        createdAt: p.createdAt.toISOString(),
        questionCount: p._count.questions,
        assignmentCount: p._count.clones,
        creatorId: p.userId,
        creatorName: p.user?.name ?? null,
        creatorEmail: p.user?.email ?? null,
        normalExtractStatus,
        normalExtractDoneCount,
        normalExtractTotalCount,
        statedMarks: stated,
        summedMarks: summed,
        marksDelta,
      };
    }),
  });
}
