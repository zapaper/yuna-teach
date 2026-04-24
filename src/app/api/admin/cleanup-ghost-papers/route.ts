import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// One-off admin cleanup for papers that were auto-cloned to non-admin
// parents by the old signup hook (now removed). A paper counts as a
// "ghost clone" when:
//   - Its owner is NOT the admin user (name = 'admin').
//   - It's a master-looking row (sourceExamId IS NULL, paperType IS NULL).
//   - Either its title is 'Math practice …', OR there's a paper with the
//     exact same title owned by the admin (the original template).
// Clones of this paper (student assignments) are cascade-deleted by the
// existing Prisma relation onDelete: Cascade.
//
// POST body: { dryRun?: boolean, parentId?: string }
//   dryRun=true  → return the list of papers that WOULD be deleted.
//   parentId     → limit to one parent; omit to sweep every non-admin parent.
export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const dryRun = body.dryRun === true;
  const parentId = typeof body.parentId === "string" ? body.parentId : null;

  const admin = await prisma.user.findFirst({
    where: { name: { equals: "admin", mode: "insensitive" } },
    select: { id: true },
  });
  if (!admin) return NextResponse.json({ error: "No admin user found" }, { status: 500 });

  // Build set of admin-owned master titles so we can spot duplicates.
  const adminMasterTitles = await prisma.examPaper.findMany({
    where: { userId: admin.id, sourceExamId: null, paperType: null },
    select: { title: true },
  });
  const titleSet = new Set(adminMasterTitles.map(t => t.title));

  // Candidate ghost-clones on non-admin parents.
  const ghosts = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      userId: parentId ?? { not: admin.id },
      OR: [
        { title: { in: [...titleSet] } },            // exact duplicate of an admin master
        { title: { startsWith: "Math practice" } },  // stray 'Math practice N' uploads
      ],
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      userId: true,
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { questions: true, clones: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      count: ghosts.length,
      papers: ghosts.map(g => ({
        id: g.id,
        title: g.title,
        createdAt: g.createdAt.toISOString(),
        creatorName: g.user?.name ?? null,
        creatorEmail: g.user?.email ?? null,
        questionCount: g._count.questions,
        cloneCount: g._count.clones,
      })),
    });
  }

  const ids = ghosts.map(g => g.id);
  if (ids.length === 0) return NextResponse.json({ deleted: 0 });

  // Prisma cascade deletes questions + clones + syntheticQuestions via the
  // schema's onDelete: Cascade on ExamQuestion.examPaper and on clones'
  // sourceExamId. Just delete the paper rows.
  const result = await prisma.examPaper.deleteMany({ where: { id: { in: ids } } });

  return NextResponse.json({
    deleted: result.count,
    papers: ghosts.map(g => ({ id: g.id, title: g.title, creator: g.user?.name ?? null })),
  });
}
