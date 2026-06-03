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
      createdAt: true,
      userId: true,
      metadata: true,
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { questions: true, clones: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // For each English paper, summarise normal-extract completion:
  //   "complete" — all 6 section flags true
  //   "partial"  — at least one flag true
  //   "none"     — no flags set / metadata.normalExtractEnglish missing
  // null         — non-English paper (admin row hides the badge)
  const SECTION_KEYS = ["bookletA", "grammarCloze", "editing", "compCloze", "synthesis", "compOeq"] as const;

  return NextResponse.json({
    papers: papers.map(p => {
      const isEnglish = (p.subject ?? "").toLowerCase().includes("english");
      let normalExtractStatus: "complete" | "partial" | "none" | null = null;
      let normalExtractDoneCount = 0;
      if (isEnglish) {
        const ne = ((p.metadata as { normalExtractEnglish?: Record<string, unknown> } | null)?.normalExtractEnglish ?? {}) as Record<string, unknown>;
        normalExtractDoneCount = SECTION_KEYS.filter(k => ne[k] === true).length;
        if (normalExtractDoneCount === SECTION_KEYS.length) normalExtractStatus = "complete";
        else if (normalExtractDoneCount > 0) normalExtractStatus = "partial";
        else normalExtractStatus = "none";
      }
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
        normalExtractTotalCount: SECTION_KEYS.length,
      };
    }),
  });
}
