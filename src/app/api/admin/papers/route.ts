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
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { questions: true, clones: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    papers: papers.map(p => ({
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
    })),
  });
}
