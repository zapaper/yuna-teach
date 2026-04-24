import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// One-off admin cleanup for papers that were auto-cloned to non-admin
// parents by the old signup hook (now removed). Strict ghost criteria:
//   - Owner is NOT the admin user (name = 'admin').
//   - Master-looking row (sourceExamId IS NULL, paperType IS NULL).
//   - pdfPath is non-null AND points at the SAME physical file as an
//     admin-owned master paper. This is the definitive fingerprint —
//     the old clone copied pdfPath verbatim, so every ghost row shares
//     its PDF with an admin paper. Parent-uploaded papers would have
//     their own pdfPath.
//
// We intentionally do NOT match on title alone (too risky — a parent
// could legitimately name their own upload "Math practice 5").
// Clones of matched rows cascade-delete via the Prisma relation.
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

  // Every pdfPath owned by the admin. A ghost clone's pdfPath MUST be in
  // this set — that's how we know the paper isn't a genuine parent upload.
  const adminPdfPaths = await prisma.examPaper.findMany({
    where: {
      userId: admin.id,
      sourceExamId: null,
      paperType: null,
      pdfPath: { not: null },
    },
    select: { pdfPath: true },
  });
  const pdfPathSet = new Set(adminPdfPaths.map(t => t.pdfPath).filter((p): p is string => !!p));

  if (pdfPathSet.size === 0) {
    return NextResponse.json({ dryRun: true, count: 0, papers: [], note: "Admin owns no master papers with pdfPath — nothing to match against." });
  }

  // Candidate ghost-clones on non-admin parents: master-looking rows whose
  // pdfPath matches an admin paper. By construction this can't delete a
  // parent's own uploaded paper (different pdfPath).
  const ghosts = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      userId: parentId ?? { not: admin.id },
      pdfPath: { in: [...pdfPathSet] },
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      userId: true,
      pdfPath: true,
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { questions: true, clones: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Extra safety: papers that already have student clones (assignments)
  // represent student work. Deleting them cascade-deletes those attempts.
  // Skip by default — admin handles these manually if needed.
  const safeGhosts = ghosts.filter(g => g._count.clones === 0);
  const skippedWithClones = ghosts.filter(g => g._count.clones > 0);

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      count: safeGhosts.length,
      skippedCount: skippedWithClones.length,
      skippedNote: skippedWithClones.length > 0
        ? `${skippedWithClones.length} ghost paper(s) have student clones (attempts) and were skipped for safety. Delete them manually from Manage Papers if you're sure.`
        : undefined,
      papers: safeGhosts.map(g => ({
        id: g.id,
        title: g.title,
        createdAt: g.createdAt.toISOString(),
        creatorName: g.user?.name ?? null,
        creatorEmail: g.user?.email ?? null,
        questionCount: g._count.questions,
        cloneCount: g._count.clones,
      })),
      skipped: skippedWithClones.map(g => ({
        id: g.id,
        title: g.title,
        creatorName: g.user?.name ?? null,
        cloneCount: g._count.clones,
      })),
    });
  }

  const ids = safeGhosts.map(g => g.id);
  if (ids.length === 0) return NextResponse.json({ deleted: 0, skippedCount: skippedWithClones.length });

  // Prisma cascade deletes questions via onDelete: Cascade. We only delete
  // rows where cloneCount is 0, so no student attempts are touched. The
  // shared pdfPath on disk is NOT deleted — the admin's original paper
  // still points at it and keeps working.
  const result = await prisma.examPaper.deleteMany({ where: { id: { in: ids } } });

  return NextResponse.json({
    deleted: result.count,
    skippedCount: skippedWithClones.length,
    papers: safeGhosts.map(g => ({ id: g.id, title: g.title, creator: g.user?.name ?? null })),
  });
}
